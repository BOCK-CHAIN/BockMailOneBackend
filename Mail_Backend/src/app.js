const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/authRoutes');
const emailRoutes = require('./routes/emailRoutes');

const app = express();

// Middleware
app.use(cors()); 
app.use(express.json()); 
app.use(express.static('public'));
// Routes
app.use('/', authRoutes); 
app.use('/api', emailRoutes); 

app.use((req, res, next) => {
    res.status(404).json({ message: 'Route Not Found' });
});
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: 'Something went wrong!', error: err.message });
});

module.exports = app;