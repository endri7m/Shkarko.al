const { Client } = require('pg');

const databaseUrl = 'postgresql://postgres.rtipsoynvfcwfeaohqvt:6FakYHNdXe3JChnc@aws-1-eu-west-1.pooler.supabase.com:6543/postgres';

const client = new Client({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

client.connect()
  .then(() => {
    console.log('SUCCESSFUL CONNECTION');
    return client.end();
  })
  .catch(err => {
    console.error('CONNECTION ERROR TYPE:', err.constructor.name);
    console.error('CONNECTION ERROR MESSAGE:', err.message);
    console.error('FULL ERROR:', err);
  });
