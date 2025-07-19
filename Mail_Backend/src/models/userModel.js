// my-email-backend/src/models/userModel.js
const pool = require('../config/db');
const { convert } = require('html-to-text');

// Helper function for robust recipients parsing
function parseRecipientsSafely(recipientsString, emailId = 'unknown') {
    const safeRecipientsString = String(recipientsString || '');

    if (!safeRecipientsString) {
        return [];
    }

    if (safeRecipientsString.startsWith('[') && safeRecipientsString.endsWith(']')) {
        try {
            const parsed = JSON.parse(safeRecipientsString);
            if (Array.isArray(parsed)) {
                return parsed;
            } else {
                console.warn(`Parsed recipients for email ID ${emailId} was not an array: ${safeRecipientsString}. Wrapping in array.`);
                return [parsed];
            }
        } catch (e) {
            console.warn(`Failed to parse JSON recipients for email ID ${emailId}: ${safeRecipientsString}. Error: ${e.message}. Treating as plain string.`);
            return [safeRecipientsString];
        }
    } else {
        return [safeRecipientsString];
    }
}


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

    async addSentEmail(userId, sender, recipients, subject, htmlBody) {
        const plainBody = convert(htmlBody, {
            wordwrap: 130,
            selectors: [{ selector: 'img', format: 'skip' }]
        });

        const res = await pool.query(
            'INSERT INTO sent_emails (user_id, sender, recipients, subject, plain_body, body_html, received_at, folder, is_starred) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, FALSE) RETURNING *', // Default is_starred: FALSE
            [userId, sender, JSON.stringify(recipients), subject, plainBody, htmlBody, 'sent']
        );
        return res.rows[0];
    },

    async addReceivedEmail(userId, sender, recipients, subject, plainBody, htmlBody) {
        const finalPlainBody = plainBody || convert(htmlBody, {
            wordwrap: 130,
            selectors: [{ selector: 'img', format: 'skip' }]
        });

        const res = await pool.query(
            'INSERT INTO received_emails (user_id, sender, recipients, subject, plain_body, body_html, received_at, folder, is_starred) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, FALSE) RETURNING *', // Default is_starred: FALSE
            [userId, sender, JSON.stringify(recipients), subject, finalPlainBody, htmlBody, 'inbox']
        );
        return res.rows[0];
    },

    // Modified to filter out trashed emails and use robust recipients parsing, and include is_starred
    async getSentEmails(userId) {
        const res = await pool.query(
            "SELECT id, sender, recipients, subject, plain_body, body_html, received_at, is_starred FROM sent_emails WHERE user_id = $1 AND folder != 'trash' ORDER BY received_at DESC",
            [userId]
        );
        return res.rows.map(row => ({
            ...row,
            recipients: parseRecipientsSafely(row.recipients, row.id)
        }));
    },

    // Modified to filter out trashed emails and use robust recipients parsing, and include is_starred
    async getReceivedEmails(userId) {
        const res = await pool.query(
            "SELECT id, sender, recipients, subject, plain_body, body_html, received_at, is_starred FROM received_emails WHERE user_id = $1 AND folder != 'trash' ORDER BY received_at DESC",
            [userId]
        );
        return res.rows.map(row => ({
            ...row,
            recipients: parseRecipientsSafely(row.recipients, row.id)
        }));
    },

    // DRAFT FUNCTIONS

    async saveDraft(userId, recipientEmail, subject, bodyHtml, attachmentsInfo, draftId = null) {
        if (draftId) {
            const res = await pool.query(
                `UPDATE drafts
                 SET recipient_email = $1, subject = $2, body_html = $3, attachments_info = $4, last_saved_at = NOW(), is_trashed = FALSE
                 WHERE id = $5 AND user_id = $6 RETURNING id, is_starred`, // Include is_starred in return
                [recipientEmail, subject, bodyHtml, attachmentsInfo, draftId, userId]
            );
            return res.rows[0];
        } else {
            const res = await pool.query(
                `INSERT INTO drafts (user_id, recipient_email, subject, body_html, attachments_info, last_saved_at, is_trashed, is_starred)
                 VALUES ($1, $2, $3, $4, $5, NOW(), FALSE, FALSE) RETURNING id, is_starred`, // Default is_starred: FALSE
                [userId, recipientEmail, subject, bodyHtml, attachmentsInfo]
            );
            return res.rows[0];
        }
    },

    // Modified to filter out trashed drafts and include is_starred
    async getDraftsByUserId(userId) {
        const res = await pool.query(
            `SELECT id, recipient_email, subject, body_html, attachments_info, last_saved_at, is_starred
             FROM drafts
             WHERE user_id = $1 AND is_trashed = FALSE
             ORDER BY last_saved_at DESC`,
            [userId]
        );
        return res.rows.map(row => ({
            ...row,
            attachments_info: row.attachments_info ? JSON.parse(row.attachments_info) : [],
        }));
    },

    async moveEmailToTrash(emailId, userId, emailType) {
        let tableName;
        if (emailType === 'sent') {
            tableName = 'sent_emails';
        } else if (emailType === 'inbox') {
            tableName = 'received_emails';
        } else {
            throw new Error('Invalid email type for moving to trash.');
        }

        const res = await pool.query(
            `UPDATE ${tableName} SET folder = 'trash' WHERE id = $1 AND user_id = $2 RETURNING id`,
            [emailId, userId]
        );
        return res.rows[0];
    },

    async moveDraftToTrash(draftId, userId) {
        const res = await pool.query(
            `UPDATE drafts SET is_trashed = TRUE WHERE id = $1 AND user_id = $2 RETURNING id`,
            [draftId, userId]
        );
        return res.rows[0];
    },

    // Modified to include is_starred for trashed items
    async getTrashedItemsByUserId(userId) {
        const trashedSent = await pool.query(
            `SELECT id, 'sent' as type, sender, recipients, subject, plain_body, body_html, received_at as last_saved_at, folder, is_starred
             FROM sent_emails
             WHERE user_id = $1 AND folder = 'trash'`,
            [userId]
        );

        const trashedReceived = await pool.query(
            `SELECT id, 'inbox' as type, sender, recipients, subject, plain_body, body_html, received_at as last_saved_at, folder, is_starred
             FROM received_emails
             WHERE user_id = $1 AND folder = 'trash'`,
            [userId]
        );

        const trashedDrafts = await pool.query(
            `SELECT id, 'draft' as type, recipient_email as recipients, subject, body_html, attachments_info, last_saved_at, NULL as folder, is_starred
             FROM drafts
             WHERE user_id = $1 AND is_trashed = TRUE`,
            [userId]
        );

        let allTrashedItems = [
            ...trashedSent.rows.map(row => ({ ...row, recipients: parseRecipientsSafely(row.recipients, row.id) })),
            ...trashedReceived.rows.map(row => ({ ...row, recipients: parseRecipientsSafely(row.recipients, row.id) })),
            ...trashedDrafts.rows.map(row => ({ ...row, attachments_info: row.attachments_info ? JSON.parse(row.attachments_info) : [] }))
        ];

        allTrashedItems.sort((a, b) => new Date(b.last_saved_at) - new Date(a.last_saved_at));

        return allTrashedItems;
    },

    async permanentlyDeleteEmail(emailId, userId, emailType) {
        let tableName;
        if (emailType === 'sent') {
            tableName = 'sent_emails';
        } else if (emailType === 'inbox') {
            tableName = 'received_emails';
        } else {
            throw new Error('Invalid email type for permanent deletion.');
        }

        const res = await pool.query(
            `DELETE FROM ${tableName} WHERE id = $1 AND user_id = $2`,
            [emailId, userId]
        );
        return res;
    },

    async permanentlyDeleteDraft(draftId, userId) {
        const res = await pool.query(
            `DELETE FROM drafts WHERE id = $1 AND user_id = $2`,
            [draftId, userId]
        );
        return res;
    },

    async restoreEmail(emailId, userId, originalFolder) {
        let tableName;
        if (originalFolder === 'sent') {
            tableName = 'sent_emails';
        } else if (originalFolder === 'inbox') {
            tableName = 'received_emails';
        } else {
            throw new Error('Invalid original folder for email restoration.');
        }
        const res = await pool.query(
            `UPDATE ${tableName} SET folder = $1 WHERE id = $2 AND user_id = $3 RETURNING id`,
            [originalFolder, emailId, userId]
        );
        return res.rows[0];
    },

    async restoreDraft(draftId, userId) {
        const res = await pool.query(
            `UPDATE drafts SET is_trashed = FALSE WHERE id = $1 AND user_id = $2 RETURNING id`,
            [draftId, userId]
        );
        return res.rows[0];
    },

    // NEW: Function to update starred status for emails
    async updateEmailStarredStatus(emailId, userId, emailType, isStarred) {
        let tableName;
        if (emailType === 'sent') {
            tableName = 'sent_emails';
        } else if (emailType === 'inbox') {
            tableName = 'received_emails';
        } else {
            throw new Error('Invalid email type for updating starred status.');
        }

        const res = await pool.query(
            `UPDATE ${tableName} SET is_starred = $1 WHERE id = $2 AND user_id = $3 RETURNING id, is_starred`,
            [isStarred, emailId, userId]
        );
        return res.rows[0]; // Returns { id, is_starred }
    },

    // NEW: Function to update starred status for drafts
    async updateDraftStarredStatus(draftId, userId, isStarred) {
        const res = await pool.query(
            `UPDATE drafts SET is_starred = $1 WHERE id = $2 AND user_id = $3 RETURNING id, is_starred`,
            [isStarred, draftId, userId]
        );
        return res.rows[0]; // Returns { id, is_starred }
    },

    // NEW: Function to get all starred items
    async getStarredItemsByUserId(userId) {
        // Fetch starred sent emails
        const starredSent = await pool.query(
            `SELECT id, 'sent' as type, sender, recipients, subject, plain_body, body_html, received_at as last_saved_at, folder, is_starred
             FROM sent_emails
             WHERE user_id = $1 AND is_starred = TRUE AND folder != 'trash'`, // Only starred and not in trash
            [userId]
        );

        // Fetch starred received emails
        const starredReceived = await pool.query(
            `SELECT id, 'inbox' as type, sender, recipients, subject, plain_body, body_html, received_at as last_saved_at, folder, is_starred
             FROM received_emails
             WHERE user_id = $1 AND is_starred = TRUE AND folder != 'trash'`, // Only starred and not in trash
            [userId]
        );

        // Fetch starred drafts
        const starredDrafts = await pool.query(
            `SELECT id, 'draft' as type, recipient_email as recipients, subject, body_html, attachments_info, last_saved_at, NULL as folder, is_starred
             FROM drafts
             WHERE user_id = $1 AND is_starred = TRUE AND is_trashed = FALSE`, // Only starred and not in trash
            [userId]
        );

        let allStarredItems = [
            ...starredSent.rows.map(row => ({ ...row, recipients: parseRecipientsSafely(row.recipients, row.id) })),
            ...starredReceived.rows.map(row => ({ ...row, recipients: parseRecipientsSafely(row.recipients, row.id) })),
            ...starredDrafts.rows.map(row => ({ ...row, attachments_info: row.attachments_info ? JSON.parse(row.attachments_info) : [] }))
        ];

        allStarredItems.sort((a, b) => new Date(b.last_saved_at) - new Date(a.last_saved_at));

        return allStarredItems;
    }
};

module.exports = User;
