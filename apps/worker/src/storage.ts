import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';

const s3Endpoint = process.env.S3_ENDPOINT || 'http://localhost:9000';
const s3AccessKey = process.env.S3_ACCESS_KEY || 'minioadmin';
const s3SecretKey = process.env.S3_SECRET_KEY || 'minioadmin';
const s3Bucket = process.env.S3_BUCKET || 'sonicflow-bucket';
const s3Region = process.env.S3_REGION || 'us-east-1';

// Setup S3 Client (forcePathStyle is crucial for local MinIO configuration)
export const s3Client = new S3Client({
  endpoint: s3Endpoint,
  credentials: {
    accessKeyId: s3AccessKey,
    secretAccessKey: s3SecretKey,
  },
  region: s3Region,
  forcePathStyle: true, 
});

/**
 * Upload a local file to S3-compatible storage.
 */
export async function uploadToS3(filePath: string, key: string, contentType: string): Promise<void> {
  const fileStream = fs.createReadStream(filePath);
  
  const command = new PutObjectCommand({
    Bucket: s3Bucket,
    Key: key,
    Body: fileStream,
    ContentType: contentType,
  });

  await s3Client.send(command);
  console.log(`Successfully uploaded ${key} to bucket ${s3Bucket}`);
}

/**
 * Generate a pre-signed download link for a private S3 object with a 1-hour expiration TTL.
 */
export async function getDownloadPresignedUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: s3Bucket,
    Key: key,
  });

  // 1 Hour = 3600 Seconds
  const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  return presignedUrl;
}
