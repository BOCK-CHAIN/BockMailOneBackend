// my-email-backend/src/models/userModel.js
const pool = require('../config/db');
const { convert } = require('html-to-text'); // We'll use this library to strip HTML

const User = {
    async findByEmail(email) {
        const res = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        return res.rows[0];
    },

    async create(email, hashedPassword, name) {
        const res = await pool.query(
            'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name',
            [email, hashedPassword, name]
        );
        return res.rows[0];
    },

    async findById(id) {
        const res = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [id]);
        return res.rows[0];
    },

    // Modified to accept htmlBody and derive plainBody
    async addSentEmail(userId, sender, recipients, subject, htmlBody) {
        // Convert HTML to plain text for plain_body column
        const plainBody = convert(htmlBody, {
            wordwrap: 130,
            selectors: [{ selector: 'img', format: 'skip' }] // Skip images in plain text
        });

        const res = await pool.query(
            'INSERT INTO sent_emails (user_id, sender, recipients, subject, plain_body, body_html, received_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *',
            [userId, sender, JSON.stringify(recipients), subject, plainBody, htmlBody]
        );
        return res.rows[0];
    },

    // Modified to accept htmlBody and derive plainBody (for consistency, though webhook provides both)
    async addReceivedEmail(userId, sender, recipients, subject, plainBody, htmlBody) {
        // If webhook provides plainBody, use it. Otherwise, derive from htmlBody.
        const finalPlainBody = plainBody || convert(htmlBody, {
            wordwrap: 130,
            selectors: [{ selector: 'img', format: 'skip' }]
        });

        const res = await pool.query(
            'INSERT INTO received_emails (user_id, sender, recipients, subject, plain_body, body_html, received_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *',
            [userId, sender, JSON.stringify(recipients), subject, finalPlainBody, htmlBody]
        );
        return res.rows[0];
    },

    async getSentEmails(userId) {
        const res = await pool.query(
            'SELECT id, sender, recipients, subject, plain_body, body_html, received_at FROM sent_emails WHERE user_id = $1 ORDER BY received_at DESC',
            [userId]
        );
        return res.rows.map(row => ({
            ...row,
            recipients: row.recipients
        }));
    },

    async getReceivedEmails(userId) {
        const res = await pool.query(
            'SELECT id, sender, recipients, subject, plain_body, body_html, received_at FROM received_emails WHERE user_id = $1 ORDER BY received_at DESC',
            [userId]
        );
        return res.rows.map(row => ({
            ...row,
            recipients: row.recipients
        }));
    }
};

module.exports = User;