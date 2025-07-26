// my-email-backend/src/routes/emailRoutes.js
const express = require('express');
const axios = require('axios');
const authenticateToken = require('../middleware/authMiddleware');
const User = require('../models/userModel');
const mailparser = require('mailparser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');   

const router = express.Router();
 // --- MULTER CONFIG FOR DISK STORAGE (for profile pictures) ---
// We need a separate multer instance for saving files to disk
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      const uploadPath = 'public/uploads/';
      // Ensure the directory exists
      fs.mkdirSync(uploadPath, { recursive: true });
      cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
      // Create a unique filename to avoid overwriting files
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, `user-${req.user.id}-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
  });
  const uploadProfilePic = multer({ storage: storage });

// Initialize multer for handling file uploads and form data
const upload = multer({ storage: multer.memoryStorage() });

// ===============================================
// CORE EMAIL & WEBHOOK ROUTES
// ===============================================

// Route to send email - NOW HANDLES FILE UPLOADS AND MOVING DRAFT TO TRASH
router.post('/send-email', authenticateToken, upload.array('attachments'), async (req, res) => {
    const { to, subject, bodyHtml, scheduledAt, draftIdToClear } = req.body;
    const from = req.user.email;
    const userId = req.user.id;

    if (!to || !subject || !bodyHtml) {
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

        const attachmentsForPostal = req.files ? req.files.map(file => ({
            filename: file.originalname,
            content: file.buffer.toString('base64'),
            encoding: 'base64',
            mimetype: file.mimetype,
        })) : [];

        if (scheduledAt) {
            console.log(`Email scheduled for ${scheduledAt} to ${to}`);
            
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

            await User.addSentEmail(userId, from, recipientsArray, subject, bodyHtml);

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

// Webhook for inbound emails from Postal
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


// Route to fetch sent or inbox emails
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

// ===============================================
// DRAFT ROUTES
// ===============================================

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
        res.status(200).json({ message: 'Draft saved successfully!', draftId: result.id, is_starred: result.is_starred });
    } catch (error) {
        console.error('Error saving draft:', error);
        res.status(500).json({ message: 'Failed to save draft.', error: error.message });
    }
});

// Get all Drafts for the authenticated user
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

// ===============================================
// TRASH ROUTES
// ===============================================

// Move an email (sent or inbox) to Trash
router.post('/trash/email', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { emailId, emailType } = req.body;

    if (!emailId || !emailType) {
        return res.status(400).json({ message: 'Email ID and type are required.' });
    }
    if (!['sent', 'inbox'].includes(emailType)) {
        return res.status(400).json({ message: 'Invalid email type. Must be "sent" or "inbox".' });
    }

    try {
        const result = await User.moveEmailToTrash(parseInt(emailId), userId, emailType);
        if (result && result.id) {
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
        if (result && result.id) {
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
    const { type } = req.query;

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

// ===============================================
// RESTORE ROUTES
// ===============================================

// Restore an Email from Trash
router.post('/trash/restore/email', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { emailId, originalFolder } = req.body;

    if (!emailId || !originalFolder) {
        return res.status(400).json({ message: 'Email ID and original folder are required for restoration.' });
    }
    if (!['sent', 'inbox'].includes(originalFolder)) {
        return res.status(400).json({ message: 'Invalid original folder. Must be "sent" or "inbox".' });
    }

    try {
        const result = await User.restoreEmail(parseInt(emailId), userId, originalFolder);
        if (result && result.id) {
            res.status(200).json({ message: 'Email restored successfully!' });
        } else {
            res.status(404).json({ message: 'Email not found or not authorized to restore.' });
        }
    } catch (error) {
        console.error('Error restoring email:', error);
        res.status(500).json({ message: 'Failed to restore email.', error: error.message });
    }
});

// Restore a Draft from Trash
router.post('/trash/restore/draft', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { draftId } = req.body;

    if (!draftId) {
        return res.status(400).json({ message: 'Draft ID is required for restoration.' });
    }

    try {
        const result = await User.restoreDraft(parseInt(draftId), userId);
        if (result && result.id) {
            res.status(200).json({ message: 'Draft restored successfully!' });
        } else {
            res.status(404).json({ message: 'Draft not found or not authorized to restore.' });
        }
    } catch (error) {
        console.error('Error restoring draft:', error);
        res.status(500).json({ message: 'Failed to restore draft.', error: error.message });
    }
});

// ===============================================
// STARRED ROUTES
// ===============================================

// Toggle Starred Status for an Email
router.patch('/starred/email', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { emailId, emailType, isStarred } = req.body;

    if (!emailId || !emailType || typeof isStarred !== 'boolean') {
        return res.status(400).json({ message: 'Email ID, type, and starred status are required.' });
    }
    if (!['sent', 'inbox'].includes(emailType)) {
        return res.status(400).json({ message: 'Invalid email type. Must be "sent" or "inbox".' });
    }

    try {
        const result = await User.updateEmailStarredStatus(parseInt(emailId), userId, emailType, isStarred);
        if (result && result.id) {
            res.status(200).json({ message: 'Email starred status updated!', is_starred: result.is_starred });
        } else {
            res.status(404).json({ message: 'Email not found or not authorized to update.' });
        }
    } catch (error) {
        console.error('Error updating email starred status:', error);
        res.status(500).json({ message: 'Failed to update email starred status.', error: error.message });
    }
});

// Toggle Starred Status for a Draft
router.patch('/starred/draft', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { draftId, isStarred } = req.body;

    if (!draftId || typeof isStarred !== 'boolean') {
        return res.status(400).json({ message: 'Draft ID and starred status are required.' });
    }

    try {
        const result = await User.updateDraftStarredStatus(parseInt(draftId), userId, isStarred);
        if (result && result.id) {
            res.status(200).json({ message: 'Draft starred status updated!', is_starred: result.is_starred });
        } else {
            res.status(404).json({ message: 'Draft not found or not authorized to update.' });
        }
    } catch (error) {
        console.error('Error updating draft starred status:', error);
        res.status(500).json({ message: 'Failed to update draft starred status.', error: error.message });
    }
});

// Get all Starred Items
router.get('/starred', authenticateToken, async (req, res) => {
    const userId = req.user.id;

    try {
        const starredItems = await User.getStarredItemsByUserId(userId);
        res.status(200).json(starredItems);
    } catch (error) {
        console.error('Error fetching starred items:', error);
        res.status(500).json({ message: 'Failed to fetch starred items.', error: error.message });
    }
});

// ===============================================
// GENERAL SETTINGS ROUTES
// ===============================================

    // --- GET User's General Settings ---
    router.get('/settings/general', authenticateToken, async (req, res) => {
    try {
        const settings = await User.getUserSettings(req.user.id);
        if (!settings) {
        return res.status(404).json({ message: 'Settings not found for user.' });
        }
        res.status(200).json(settings);
    } catch (error) {
        console.error('Error fetching general settings:', error);
        res.status(500).json({ message: 'Failed to fetch settings.' });
    }
    });


    // --- UPDATE User's General Settings ---
    // Using upload.none() to handle form data from the frontend without file uploads
    router.patch('/settings/general', authenticateToken, upload.none(), async (req, res) => {
    try {
        // The req.body will contain the settings fields to update
        const updatedSettings = await User.updateUserSettings(req.user.id, req.body);
        res.status(200).json({ 
            message: 'Settings updated successfully!', 
            settings: updatedSettings 
        });
    } catch (error) {
        console.error('Error updating general settings:', error);
        res.status(500).json({ message: 'Failed to update settings.' });
    }
    });
   
    // ===============================================
// PROFILE PICTURE UPLOAD ROUTE
// ===============================================
router.post('/settings/upload-profile-picture', authenticateToken, uploadProfilePic.single('profilePicture'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'No profile picture file uploaded.' });
      }
  
      // Construct the URL path to the uploaded file
      const profilePictureUrl = `/uploads/${req.file.filename}`;
  
      // Update the user's settings in the database with the new URL
      const updatedSettings = await User.updateUserSettings(req.user.id, {
        profile_picture_url: profilePictureUrl
      });
  
      res.status(200).json({
        message: 'Profile picture uploaded successfully!',
        settings: updatedSettings
      });
  
    } catch (error) {
      console.error('Error uploading profile picture:', error);
      res.status(500).json({ message: 'Failed to upload profile picture.' });
    }
  });
  // ===============================================
// SIGNATURE CRUD ROUTES
// ===============================================

// --- CREATE a new signature ---
router.post('/signatures', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { name, content } = req.body;

    if (!name || !content) {
        return res.status(400).json({ message: 'Signature name and content are required.' });
    }

    try {
        const newSignature = await User.createSignature(userId, name, content);
        res.status(201).json({ message: 'Signature created successfully!', signature: newSignature });
    } catch (error) {
        console.error('Error creating signature:', error);
        res.status(500).json({ message: 'Failed to create signature.' });
    }
});

// --- UPDATE an existing signature ---
router.patch('/signatures/:id', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const signatureId = parseInt(req.params.id);
    const { name, content } = req.body;

    if (!name || !content) {
        return res.status(400).json({ message: 'Signature name and content are required.' });
    }

    try {
        const updatedSignature = await User.updateSignature(signatureId, userId, name, content);
        res.status(200).json({ message: 'Signature updated successfully!', signature: updatedSignature });
    } catch (error) {
        console.error('Error updating signature:', error);
        // The model throws an error if not found/authorized, which we catch here
        res.status(404).json({ message: error.message });
    }
});

// --- DELETE a signature ---
router.delete('/signatures/:id', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const signatureId = parseInt(req.params.id);

    try {
        const rowCount = await User.deleteSignature(signatureId, userId);
        if (rowCount === 0) {
            return res.status(404).json({ message: 'Signature not found or user not authorized.' });
        }
        res.status(200).json({ message: 'Signature deleted successfully.' });
    } catch (error) {
        console.error('Error deleting signature:', error);
        res.status(500).json({ message: 'Failed to delete signature.' });
    }
});

module.exports = router;
