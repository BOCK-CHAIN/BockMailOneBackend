## sql schema of different tables
### Received Emails table
```sql
CREATE TABLE received_emails (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- Links to the users table
    sender VARCHAR(255) NOT NULL,
    recipients JSONB NOT NULL, -- Stores an array of recipient emails (your user's email)
    subject VARCHAR(255),
    plain_body TEXT,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```
### Sent Emails table
```sql
CREATE TABLE sent_emails (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- Links to the users table
    sender VARCHAR(255) NOT NULL,
    recipients JSONB NOT NULL, -- Stores an array of recipient emails (e.g., '["recipient1@ex.com", "recipient2@ex.com"]')
    subject VARCHAR(255),
    plain_body TEXT,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```
### User table
```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL, -- Stores the hashed password
    name VARCHAR(255),             -- New column for user's name
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```