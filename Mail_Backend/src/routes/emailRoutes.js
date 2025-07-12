// my-email-backend/src/routes/emailRoutes.js
const express = require('express');
const axios = require('axios');
const authenticateToken = require('../middleware/authMiddleware');
const User = require('../models/userModel');
const mailparser = require('mailparser');
const multer = require('multer'); // Import multer

const router = express.Router();

// Configure multer for file uploads
// Using memory storage for simplicity; for production, consider disk storage or cloud storage
const upload = multer({ storage: multer.memoryStorage() });

// Route to send email - NOW HANDLES FILE UPLOADS AND MOVING DRAFT TO TRASH
router.post('/send-email', authenticateToken, upload.array('attachments'), async (req, res) => {
    const { to, subject, bodyHtml, scheduledAt, draftIdToClear } = req.body;
    const from = req.user.email;
    const userId = req.user.id; // Get userId from authenticated token

    // Ensure all required fields are present for immediate send
    // If scheduled, subject/body might be empty initially, but 'to' is usually required.
    if (!to || !subject || !bodyHtml) {
        // For drafts, we might allow empty fields, but for sending, they are crucial.
        // This check is for actual sending, not draft saving.
        // If it's a scheduled email, we still need 'to'
        if (!scheduledAt) {
            return res.status(400).json({ message: 'To, Subject, and Body are required for immediate sending.' });
        } else if (!to) {
            return res.status(400).json({ message: 'Recipient is required for scheduling.' });
        }
    }

    const postalApiUrl = process.env.POSTAL_API_URL;
    const postalApiKey = process.env.POSTAL_API_KEY;

    if (!postalApiUrl || !postalApiKey) {
        console.error('Postal API URL or Key not set in environment variables.');
        return res.status(500).json({ message: 'Postal service not configured.' });
    }

    try {
        const recipientsArray = to.split(',').map(email => email.trim()).filter(email => email);

        // Prepare attachments for Postal API
        const attachmentsForPostal = req.files ? req.files.map(file => ({
            filename: file.originalname,
            content: file.buffer.toString('base64'), // Postal expects base64 content
            encoding: 'base64',
            mimetype: file.mimetype,
        })) : [];

        if (scheduledAt) {
            // Placeholder for scheduling logic.
            // In a real app, you'd save this to a 'scheduled_emails' table
            // and have a background job send it at the scheduled time.
            console.log(`Email scheduled for ${scheduledAt} to ${to}`);
            // Example: await User.addScheduledEmail(userId, from, recipientsArray, subject, bodyHtml, scheduledAt);
            
            // NEW: Move draft to trash if it was sent from a draft
            if (draftIdToClear) {
                try {
                    const moveResult = await User.moveDraftToTrash(parseInt(draftIdToClear), userId);
                    if (moveResult.rowCount === 0) {
                        console.warn(`Draft ${draftIdToClear} not found or not owned by user ${userId} after scheduling.`);
                    } else {
                        console.log(`Draft ${draftIdToClear} moved to trash after scheduling.`);
                    }
                } catch (moveErr) {
                    console.error('Error moving draft to trash after scheduling:', moveErr);
                }
            }
            return res.status(200).json({ message: 'Email scheduled successfully!' });

        } else {
            // Send immediately via Postal
            const response = await axios.post(
                postalApiUrl,
                {
                    to: recipientsArray,
                    from: from,
                    subject: subject,
                    html_body: bodyHtml,
                    attachments: attachmentsForPostal,
                },
                {
                    headers: {
                        'X-Server-API-Key': postalApiKey,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log('Email sent via Postal:', response.data);

            // Store sent email in your database.
            await User.addSentEmail(userId, from, recipientsArray, subject, bodyHtml);

            // NEW: Move draft to trash if it was sent from a draft
            if (draftIdToClear) {
                try {
                    const moveResult = await User.moveDraftToTrash(parseInt(draftIdToClear), userId);
                    if (moveResult.rowCount === 0) {
                        console.warn(`Draft ${draftIdToClear} not found or not owned by user ${userId} after sending.`);
                    } else {
                        console.log(`Draft ${draftIdToClear} moved to trash after sending.`);
                    }
                } catch (moveErr) {
                    console.error('Error moving draft to trash after sending:', moveErr);
                }
            }

            res.status(200).json({ message: 'Email sent and stored!', postalResponse: response.data });
        }

    } catch (err) {
        console.error('Error sending email via Postal or storing:', err.response?.data || err.message);
        res.status(500).json({ message: 'Failed to send email via Postal or store it.', error: err.response?.data || err.message });
    }
});

// Webhook for inbound emails from Postal (remains mostly the same)
router.post('/webhooks/postal/inbound', async (req, res) => {
    console.log('Received inbound email webhook:', JSON.stringify(req.body, null, 2));

    let emailData = req.body.message;
    if (!emailData) {
        if (typeof req.body === 'string' && req.body.startsWith('Received:')) {
            try {
                const parsedEmail = await mailparser.simpleParser(req.body);
                emailData = {
                    to: { email: parsedEmail.to?.value[0]?.address || parsedEmail.to?.text },
                    from: { email: parsedEmail.from?.value[0]?.address || parsedEmail.from?.text },
                    subject: parsedEmail.subject,
                    plain_body: parsedEmail.text,
                    html_body: parsedEmail.html,
                };
                console.log('Parsed raw email:', emailData);
            } catch (parseError) {
                console.error('Error parsing raw email from webhook:', parseError);
                return res.status(400).json({ message: 'Failed to parse raw email body.' });
            }
        } else {
             return res.status(400).json({ message: 'No message data found in webhook body.' });
        }
    }

    const recipientEmail = emailData.to.email;
    const senderEmail = emailData.from.email;
    const subject = emailData.subject;
    const plainBody = emailData.plain_body;
    const htmlBody = emailData.html_body;

    try {
        const user = await User.findByEmail(recipientEmail);
        if (user) {
            await User.addReceivedEmail(user.id, senderEmail, [recipientEmail], subject, plainBody, htmlBody);
            console.log(`Inbound email for user ${user.email} stored.`);
            res.status(200).json({ message: 'Inbound email received and stored.' });
        } else {
            console.log(`No user found for inbound email recipient: ${recipientEmail}`);
            res.status(200).json({ message: 'Recipient user not found, email not stored (expected behavior for unknown users).' });
        }
    } catch (error) {
        console.error('Error processing inbound email webhook:', error);
        res.status(500).json({ message: 'Error processing inbound email.' });
    }
});


// Route to fetch sent or inbox emails (remains the same, but model filters out trash)
router.get('/emails', authenticateToken, async (req, res) => {
    const { type } = req.query;
    const userId = req.user.id;

    try {
        let emails;
        if (type === 'sent') {
            emails = await User.getSentEmails(userId);
        } else if (type === 'inbox') {
            emails = await User.getReceivedEmails(userId);
        } else {
            return res.status(400).json({ message: 'Invalid email type specified. Use "sent" or "inbox".' });
        }
        res.status(200).json(emails);
    } catch (err) {
        console.error(`Error fetching ${type} emails:`, err);
        res.status(500).json({ message: `Failed to fetch ${type} emails.` });
    }
});

// DRAFT ROUTES (previous ones)

// Save or Update a Draft
router.post('/drafts', authenticateToken, upload.none(), async (req, res) => {
    const userId = req.user.id;
    const { id, recipient_email, subject, body_html, attachments_info } = req.body;

    try {
        const attachmentsInfoString = attachments_info ? JSON.stringify(attachments_info) : '[]';

        const result = await User.saveDraft(
            userId,
            recipient_email || '',
            subject || '',
            body_html || '',
            attachmentsInfoString,
            id ? parseInt(id) : null
        );
        res.status(200).json({ message: 'Draft saved successfully!', draftId: result.id });
    } catch (error) {
        console.error('Error saving draft:', error);
        res.status(500).json({ message: 'Failed to save draft.', error: error.message });
    }
});

// Get all Drafts for the authenticated user (model filters out trashed)
router.get('/drafts', authenticateToken, async (req, res) => {
    const userId = req.user.id;

    try {
        const drafts = await User.getDraftsByUserId(userId);
        res.status(200).json(drafts);
    } catch (error) {
        console.error('Error fetching drafts:', error);
        res.status(500).json({ message: 'Failed to fetch drafts.', error: error.message });
    }
});


// NEW TRASH ROUTES

// Move an email (sent or inbox) to Trash
router.post('/trash/email', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { emailId, emailType } = req.body; // emailType: 'sent' or 'inbox'

    if (!emailId || !emailType) {
        return res.status(400).json({ message: 'Email ID and type are required.' });
    }
    if (!['sent', 'inbox'].includes(emailType)) {
        return res.status(400).json({ message: 'Invalid email type. Must be "sent" or "inbox".' });
    }

    try {
        const result = await User.moveEmailToTrash(parseInt(emailId), userId, emailType);
        if (result && result.id) { // Check if an ID was returned (indicating success)
            res.status(200).json({ message: 'Email moved to trash successfully!' });
        } else {
            res.status(404).json({ message: 'Email not found or not authorized to move.' });
        }
    } catch (error) {
        console.error('Error moving email to trash:', error);
        res.status(500).json({ message: 'Failed to move email to trash.', error: error.message });
    }
});

// Move a draft to Trash
router.post('/trash/draft', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { draftId } = req.body;

    if (!draftId) {
        return res.status(400).json({ message: 'Draft ID is required.' });
    }

    try {
        const result = await User.moveDraftToTrash(parseInt(draftId), userId);
        if (result && result.id) { // Check if an ID was returned (indicating success)
            res.status(200).json({ message: 'Draft moved to trash successfully!' });
        } else {
            res.status(404).json({ message: 'Draft not found or not authorized to move.' });
        }
    } catch (error) {
        console.error('Error moving draft to trash:', error);
        res.status(500).json({ message: 'Failed to move draft to trash.', error: error.message });
    }
});

// Get all Trashed Items
router.get('/trash', authenticateToken, async (req, res) => {
    const userId = req.user.id;

    try {
        const trashedItems = await User.getTrashedItemsByUserId(userId);
        res.status(200).json(trashedItems);
    } catch (error) {
        console.error('Error fetching trashed items:', error);
        res.status(500).json({ message: 'Failed to fetch trashed items.', error: error.message });
    }
});

// Permanently Delete an Email from Trash
router.delete('/trash/emails/:id', authenticateToken, async (req, res) => {
    const emailId = parseInt(req.params.id);
    const userId = req.user.id;
    const { type } = req.query; // 'sent' or 'inbox' to know which table to delete from

    if (!type || !['sent', 'inbox'].includes(type)) {
        return res.status(400).json({ message: 'Email type (sent/inbox) is required for permanent deletion.' });
    }

    try {
        const result = await User.permanentlyDeleteEmail(emailId, userId, type);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Email not found or not authorized to delete permanently.' });
        }
        res.status(200).json({ message: 'Email permanently deleted successfully.' });
    } catch (error) {
        console.error('Error permanently deleting email:', error);
        res.status(500).json({ message: 'Failed to permanently delete email.', error: error.message });
    }
});

// Permanently Delete a Draft from Trash
router.delete('/trash/drafts/:id', authenticateToken, async (req, res) => {
    const draftId = parseInt(req.params.id);
    const userId = req.user.id;

    try {
        const result = await User.permanentlyDeleteDraft(draftId, userId);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Draft not found or not authorized to delete permanently.' });
        }
        res.status(200).json({ message: 'Draft permanently deleted successfully.' });
    } catch (error) {
        console.error('Error permanently deleting draft:', error);
        res.status(500).json({ message: 'Failed to permanently delete draft.', error: error.message });
    }
});


module.exports = router;
