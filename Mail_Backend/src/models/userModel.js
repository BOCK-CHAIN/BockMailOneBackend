// my-email-backend/src/models/userModel.js
const pool = require('../config/db');
const { convert } = require('html-to-text');
const bcrypt = require('bcrypt');

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
            'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name, max_page_size, undo_send_delay, profile_picture_url, signature_html', // Include new columns in return
            [email, hashedPassword, name]
        );
        return res.rows[0];
    },

    async findById(id) {
        // Include new columns in SELECT
        const res = await pool.query('SELECT id, email, name, max_page_size, undo_send_delay, profile_picture_url, signature_html FROM users WHERE id = $1', [id]);
        return res.rows[0];
    },

    async addSentEmail(userId, sender, recipients, subject, htmlBody) {
        const plainBody = convert(htmlBody, {
            wordwrap: 130,
            selectors: [{ selector: 'img', format: 'skip' }]
        });

        const res = await pool.query(
            'INSERT INTO sent_emails (user_id, sender, recipients, subject, plain_body, body_html, received_at, folder, is_starred) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, FALSE) RETURNING *',
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
            'INSERT INTO received_emails (user_id, sender, recipients, subject, plain_body, body_html, received_at, folder, is_starred) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, FALSE) RETURNING *',
            [userId, sender, JSON.stringify(recipients), subject, finalPlainBody, htmlBody, 'inbox']
        );
        return res.rows[0];
    },

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
                 WHERE id = $5 AND user_id = $6 RETURNING id, is_starred`,
                [recipientEmail, subject, bodyHtml, attachmentsInfo, draftId, userId]
            );
            return res.rows[0];
        } else {
            const res = await pool.query(
                `INSERT INTO drafts (user_id, recipient_email, subject, body_html, attachments_info, last_saved_at, is_trashed, is_starred)
                 VALUES ($1, $2, $3, $4, $5, NOW(), FALSE, FALSE) RETURNING id, is_starred`,
                [userId, recipientEmail, subject, bodyHtml, attachmentsInfo]
            );
            return res.rows[0];
        }
    },

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
        return res.rows[0];
    },

    async updateDraftStarredStatus(draftId, userId, isStarred) {
        const res = await pool.query(
            `UPDATE drafts SET is_starred = $1 WHERE id = $2 AND user_id = $3 RETURNING id, is_starred`,
            [isStarred, draftId, userId]
        );
        return res.rows[0];
    },

    async getStarredItemsByUserId(userId) {
        const starredSent = await pool.query(
            `SELECT id, 'sent' as type, sender, recipients, subject, plain_body, body_html, received_at as last_saved_at, folder, is_starred
             FROM sent_emails
             WHERE user_id = $1 AND is_starred = TRUE AND folder != 'trash'`,
            [userId]
        );

        const starredReceived = await pool.query(
            `SELECT id, 'inbox' as type, sender, recipients, subject, plain_body, body_html, received_at as last_saved_at, folder, is_starred
             FROM received_emails
             WHERE user_id = $1 AND is_starred = TRUE AND folder != 'trash'`,
            [userId]
        );

        const starredDrafts = await pool.query(
            `SELECT id, 'draft' as type, recipient_email as recipients, subject, body_html, attachments_info, last_saved_at, NULL as folder, is_starred
             FROM drafts
             WHERE user_id = $1 AND is_starred = TRUE AND is_trashed = FALSE`,
            [userId]
        );

        let allStarredItems = [
            ...starredSent.rows.map(row => ({ ...row, recipients: parseRecipientsSafely(row.recipients, row.id) })),
            ...starredReceived.rows.map(row => ({ ...row, recipients: parseRecipientsSafely(row.recipients, row.id) })),
            ...starredDrafts.rows.map(row => ({ ...row, attachments_info: row.attachments_info ? JSON.parse(row.attachments_info) : [] }))
        ];

        allStarredItems.sort((a, b) => new Date(b.last_saved_at) - new Date(a.last_saved_at));

        return allStarredItems;
    },

   // --- FETCH ALL SETTINGS AND SIGNATURES ---
   async getUserSettings(userId) {
    // Step 1: Get the main user settings, now including label visibility
    const settingsRes = await pool.query(
        `SELECT 
            name, max_page_size, undo_send_delay, profile_picture_url, 
            default_signature_new, default_signature_reply,
            label_starred_visibility, label_sent_visibility, label_drafts_visibility,
            label_trash_visibility, label_scheduled_visibility, label_spam_visibility
         FROM users WHERE id = $1`,
        [userId]
    );
    const settings = settingsRes.rows[0];

    if (!settings) {
        return null;
    }

    // Step 2: Get all signatures for that user (this part remains the same)
    const signaturesRes = await pool.query(
        'SELECT * FROM signatures WHERE user_id = $1 ORDER BY name ASC',
        [userId]
    );
    const signatures = signaturesRes.rows;

    // Step 3: Combine them into a single object
    return {
        ...settings,
        signatures: signatures,
    };
},

// --- UPDATE MAIN USER SETTINGS (including default signatures) ---
async updateUserSettings(userId, settings) {
    const { 
        max_page_size, undo_send_delay, profile_picture_url, 
        default_signature_new, default_signature_reply,
        label_starred_visibility, label_sent_visibility, label_drafts_visibility,
        label_trash_visibility, label_scheduled_visibility, label_spam_visibility
    } = settings;
    
    const res = await pool.query(
        `UPDATE users
         SET 
            max_page_size = COALESCE($1, max_page_size),
            undo_send_delay = COALESCE($2, undo_send_delay),
            profile_picture_url = COALESCE($3, profile_picture_url),
            default_signature_new = NULLIF($4, 0),
            default_signature_reply = NULLIF($5, 0),
            label_starred_visibility = COALESCE($6, label_starred_visibility),
            label_sent_visibility = COALESCE($7, label_sent_visibility),
            label_drafts_visibility = COALESCE($8, label_drafts_visibility),
            label_trash_visibility = COALESCE($9, label_trash_visibility),
            label_scheduled_visibility = COALESCE($10, label_scheduled_visibility),
            label_spam_visibility = COALESCE($11, label_spam_visibility)
         WHERE id = $12 RETURNING *`, // Returning * is easiest here
        [
            max_page_size, 
            undo_send_delay, 
            profile_picture_url, 
            default_signature_new, 
            default_signature_reply,
            label_starred_visibility,
            label_sent_visibility,
            label_drafts_visibility,
            label_trash_visibility,
            label_scheduled_visibility,
            label_spam_visibility,
            userId
        ]
    );
    return res.rows[0];
},

// --- SIGNATURE-SPECIFIC CRUD OPERATIONS ---

/**
 * Creates a new signature for a user.
 */
async createSignature(userId, name, content) {
    const res = await pool.query(
        'INSERT INTO signatures (user_id, name, content) VALUES ($1, $2, $3) RETURNING *',
        [userId, name, content]
    );
    return res.rows[0];
},

/**
 * Updates an existing signature.
 */
async updateSignature(signatureId, userId, name, content) {
    const res = await pool.query(
        'UPDATE signatures SET name = $1, content = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4 RETURNING *',
        [name, content, signatureId, userId]
    );
    // Checking res.rows[0] ensures the user owns the signature they're trying to edit
    if (!res.rows[0]) {
        throw new Error('Signature not found or user not authorized.');
    }
    return res.rows[0];
},

/**
 * Deletes a signature.
 */
async deleteSignature(signatureId, userId) {
    // First, check if this signature is a default for the user and nullify if so
    await pool.query(
        `UPDATE users SET 
            default_signature_new = CASE WHEN default_signature_new = $1 THEN NULL ELSE default_signature_new END,
            default_signature_reply = CASE WHEN default_signature_reply = $1 THEN NULL ELSE default_signature_reply END
        WHERE id = $2`,
        [signatureId, userId]
    );
    
    // Then, delete the signature itself
    const res = await pool.query(
        'DELETE FROM signatures WHERE id = $1 AND user_id = $2',
        [signatureId, userId]
    );
    // res.rowCount will be 1 if deleted, 0 if not found/not owned
    return res.rowCount;
},
async changePassword(userId, oldPassword, newPassword) {
    // Step 1: Get the current hashed password from the database
    const userRes = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
        throw new Error('User not found.');
    }
    const storedHash = userRes.rows[0].password;

    // Step 2: Compare the provided old password with the stored hash
    const isMatch = await bcrypt.compare(oldPassword, storedHash);
    if (!isMatch) {
        // If they don't match, throw an error. This is a critical security check.
        throw new Error('Incorrect current password.');
    }

    // Step 3: Hash the new password
    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(newPassword, salt);

    // Step 4: Update the database with the new hashed password
    await pool.query(
        'UPDATE users SET password = $1 WHERE id = $2',
        [newPasswordHash, userId]
    );

    return { success: true, message: 'Password updated successfully.' };
},
};

module.exports = User;
