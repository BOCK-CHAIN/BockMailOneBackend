
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.connect()
    .then(client => {
        console.log('Connected to Neon database successfully!');
        client.release();
    })
    .catch(err => {
        console.error('Error connecting to Neon database:', err.stack);
    });

module.exports = pool;