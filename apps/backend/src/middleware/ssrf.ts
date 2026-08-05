
import { Request, Response, NextFunction } from 'express';
import dns from 'dns';
import { promisify } from 'util';
import ipaddr from 'ipaddr.js'; // Note: if ipaddr.js is not present, we will implement pure JS IP parser to avoid missing dependency runtime issues.

const resolve4Async = promisify(dns.resolve4);
const resolve6Async = promisify(dns.resolve6);

/**
 * Checks if a string IP address is private, loopback, link-local, or otherwise reserved.
 */
function isPrivateIp(ip: string): boolean {
  // If it's a domain name (contains alphabetical characters), it's not an IP address
  if (/[a-zA-Z]/g.test(ip)) {
    return false;
  }

  try {
    // Normalise IPv6-mapped IPv4 addresses (e.g. ::ffff:127.0.0.1)
    let parsedIp = ip;
    if (ip.startsWith('::ffff:')) {
      parsedIp = ip.replace('::ffff:', '');
    }

    // Check if it's IPv4
    if (parsedIp.includes('.')) {
      const parts = parsedIp.split('.').map(p => parseInt(p, 10));
      if (parts.length !== 4 || parts.some(isNaN)) return true;

      const [p1, p2, p3, p4] = parts;

      // Loopback: 127.0.0.0/8
      if (p1 === 127) return true;
      // Private Class A: 10.0.0.0/8
      if (p1 === 10) return true;
      // Private Class B: 172.16.0.0/12
      if (p1 === 172 && p2 >= 16 && p2 <= 31) return true;
      // Private Class C: 192.168.0.0/16
      if (p1 === 192 && p2 === 168) return true;
      // Link-local: 169.254.0.0/16
      if (p1 === 169 && p2 === 254) return true;
      // Local broadcast/any: 0.0.0.0
      if (p1 === 0) return true;

      return false;
    }

    // Check if it's IPv6
    if (parsedIp.includes(':')) {
      // Loopback ::1
      if (parsedIp === '::1' || parsedIp === '0:0:0:0:0:0:0:1') return true;
      // Unspecified ::
      if (parsedIp === '::' || parsedIp === '0:0:0:0:0:0:0:0') return true;
      // Unique Local: fc00::/7
      if (parsedIp.toLowerCase().startsWith('fc') || parsedIp.toLowerCase().startsWith('fd')) return true;
      // Link-local: fe80::/10
      if (parsedIp.toLowerCase().startsWith('fe8')) return true;

      return false;
    }

    return true; // Unknown IP formats are rejected by default
  } catch {
    return true; // Safety default
  }
}

/**
 * SSRF Prevention Middleware
 */
export async function ssrfProtection(req: Request, res: Response, next: NextFunction) {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  try {
    const parsedUrl = new URL(url);

    // Enforce protocol validation (HTTP/HTTPS only)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return res.status(400).json({ error: 'Invalid protocol. Only HTTP and HTTPS are permitted.' });
    }

    const hostname = parsedUrl.hostname;

    // Direct check for IP hostnames
    if (isPrivateIp(hostname)) {
      return res.status(400).json({ error: 'Access to the specified address is restricted.' });
    }

    // Resolve domain names to IPs and check them with a 2-second timeout to prevent API hangs
    let resolvedIps: string[] = [];
    try {
      const resolvePromise = resolve4Async(hostname);
      resolvedIps = await Promise.race([
        resolvePromise,
        new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('DNS Timeout')), 2000))
      ]);
    } catch (e: any) {
      if (e.message === 'DNS Timeout') {
        console.warn(`[SSRF] DNS lookup timed out for host: ${hostname}. Proceeding with caution.`);
        resolvedIps = [];
      } else {
        // If IPv4 fails, try IPv6
        try {
          const resolvePromiseV6 = resolve6Async(hostname);
          resolvedIps = await Promise.race([
            resolvePromiseV6,
            new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('DNS Timeout')), 2000))
          ]);
        } catch (errV6: any) {
          if (errV6.message === 'DNS Timeout') {
            console.warn(`[SSRF] DNS lookup timed out for host: ${hostname}. Proceeding with caution.`);
            resolvedIps = [];
          } else {
            return res.status(400).json({ error: 'Could not resolve host address.' });
          }
        }
      }
    }

    for (const ip of resolvedIps) {
      if (isPrivateIp(ip)) {
        return res.status(400).json({ error: 'Access to the specified host is restricted.' });
      }
    }

    // URL is safe, pass to next handler
    next();
  } catch (error) {
    console.error('SSRF validation error:', error);
    return res.status(400).json({ error: 'Malformed or invalid URL.' });
  }
}
