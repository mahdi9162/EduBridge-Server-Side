import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import mongodb, { MongoClient } from 'mongodb';
import { createRequire } from 'module';
dotenv.config();
const app = express();
const port = process.env.PORT || '3000';
const client = new MongoClient(process.env.DATABASE_URL);

app.use(express.json());
app.use(cors());

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
const serviceAccount = require('./edubridge-production-firebase-adminsdk.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

async function run() {
  try {
    await client.connect();
    console.log('Database Connected!');

    // Database Collections
    const db = client.db('edubridge');
    const usersCollection = db.collection('users');

    // users post api
    app.post('/signup', async (req, res) => {
      try {
        const existing = await usersCollection.findOne({
          email: req.body.email,
        });

        if (existing) {
          return res.status(400).json({
            message: 'Email already exists',
          });
        }
        const result = await usersCollection.insertOne(req.body);
        res.send(result);
      } catch (error) {
        res.status(400).json({
          message: 'Failed to create user!',
          error,
        });
      }
    });

    // jwt api
    app.post('/api/auth/jwt', async (req, res) => {
      try {
        const firebaseToken = req.body.token;

        if (!firebaseToken) {
          return res.status(400).send({ message: 'Token is missing in request body' });
        }

        const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
        const uid = decodedToken.uid;

        const user = await usersCollection.findOne({ firebaseUID: uid });

        if (!user) {
          return res.status(404).send({ message: 'User profile not found in database' });
        }

        const userRole = user.userType;

        const secret = process.env.ACCESS_TOKEN_SECRET;

        if (!secret) {
          console.error('FATAL ERROR: ACCESS_TOKEN_SECRET is not defined. Check your .env file.');
          return res.status(500).send({ message: 'Server configuration error.' });
        }

        const payload = {
          uid: uid,
          userType: userRole,
        };

        const token = jwt.sign(payload, secret, {
          expiresIn: '1h',
        });
        res.send({ token, userType });
      } catch (error) {
        console.error('JWT generation error:', error);
        res.status(500).send({ message: 'Failed to generate JWT', error: error.message });
      }

      //   --------------------------
    });
  } catch (error) {
    console.error(error);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
