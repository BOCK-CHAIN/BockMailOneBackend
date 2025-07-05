const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../models/userModel');

const router = express.Router();

const APP_EMAIL_DOMAIN = process.env.APP_EMAIL_DOMAIN;

router.post('/register', async (req, res) => {
    const { name, email, password, confirmPassword } = req.body; 

    if (!name || !email || !password || !confirmPassword) {
        return res.status(400).json({ message: 'Name, Email, Password, and Confirm Password are required' });
    }

    if (password !== confirmPassword) {
        return res.status(400).json({ message: 'Password and Confirm Password do not match' });
    }

    // Enforce domain check
    if (!email.endsWith(`@${APP_EMAIL_DOMAIN}`)) {
        return res.status(400).json({ message: `Email must end with @${APP_EMAIL_DOMAIN}` });
    }

    try {
        const existingUser = await User.findByEmail(email);
        if (existingUser) {
            return res.status(409).json({ message: 'Email already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 10); 
        await User.create(email, hashedPassword, name); 

        res.status(201).json({ message: 'User registered successfully!' });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ message: 'Server error during registration.' });
    }
});

router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required' });
    }

    try {
        const user = await User.findByEmail(email);
        if (!user) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }

        // The column in the DB is 'password', but bcrypt.compare expects a hash
        // Ensure user.password actually contains the hashed string from the DB
        const isPasswordValid = await bcrypt.compare(password, user.password); // user.password should be the stored hash
        if (!isPasswordValid) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }

        const accessToken = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });

        res.status(200).json({ message: 'Login successful', accessToken });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'Server error during login.' });
    }
});

module.exports = router;