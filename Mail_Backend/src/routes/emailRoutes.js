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

// Route to send email - NOW HANDLES FILE UPLOADS
// Use upload.array('attachments') middleware to process multiple files
router.post('/send-email', authenticateToken, upload.array('attachments'), async (req, res) => {
    // req.body will contain text fields
    // req.files will contain the uploaded files
    const { to, subject, bodyHtml } = req.body;
    const from = req.user.email;

    // Ensure all required fields are present
    if (!to || !subject || !bodyHtml) {
        return res.status(400).json({ message: 'To, Subject, and Body are required.' });
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

        const response = await axios.post(
            postalApiUrl,
            {
                to: recipientsArray,
                from: from,
                subject: subject,
                html_body: bodyHtml,
                attachments: attachmentsForPostal, // Include attachments here
            },
            {
                headers: {
                    'X-Server-API-Key': postalApiKey,
                    'Content-Type': 'application/json' // Axios will handle this for FormData
                }
            }
        );

        console.log('Email sent via Postal:', response.data);

        // Store sent email in your database.
        // You might want to store attachment metadata (names, sizes) here too.
        await User.addSentEmail(req.user.id, from, recipientsArray, subject, bodyHtml);

        res.status(200).json({ message: 'Email sent and stored!', postalResponse: response.data });

    } catch (err) {
        console.error('Error sending email via Postal or storing:', err.response?.data || err.message);
        res.status(500).json({ message: 'Failed to send email via Postal or store it.', error: err.response?.data || err.message });
    }
});

// Webhook for inbound emails from Postal (remains mostly the same)
router.post('/webhooks/postal/inbound', async (req, res) => {
    console.log('Received inbound email webhook:', JSON.stringify(req.body, null, 2));

    const emailData = req.body.message;
    if (!emailData) {
        // If Postal sends raw email (text/plain), parse it
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


// Route to fetch sent or inbox emails (remains the same)
router.get('/emails', authenticateToken, async (req, res) => {
    const { type } = req.query;

    try {
        let emails;
        if (type === 'sent') {
            emails = await User.getSentEmails(req.user.id);
        } else if (type === 'inbox') {
            emails = await User.getReceivedEmails(req.user.id);
        } else {
            return res.status(400).json({ message: 'Invalid email type specified. Use "sent" or "inbox".' });
        }
        res.status(200).json(emails);
    } catch (err) {
        console.error(`Error fetching ${type} emails:`, err);
        res.status(500).json({ message: `Failed to fetch ${type} emails.` });
    }
});

module.exports = router;