## Backend parts of BockMailOne
### To run this backend part of BockMailOne:
```bash
npm i 
nodemon server.js
```
* You should create a .env file for below environment variables.
```bash
PORT=3001 
DATABASE_URL= # Paste your Neon string here
POSTAL_API_URL= # Your Postal server's API endpoint
POSTAL_API_KEY= # The Password from your Postal API Credential
JWT_SECRET= # Change this for production!
APP_EMAIL_DOMAIN=
```
