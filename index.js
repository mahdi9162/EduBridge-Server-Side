import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import { createRequire } from 'module';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const client = new MongoClient(process.env.DATABASE_URL);

app.use(express.json());
app.use(cors());

const verifyJwtToken = (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: 'Unauthorized access' });
  }

  const idToken = token.split(' ')[1];

  jwt.verify(idToken, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).send({ message: 'Forbidden access' });
    }

    req.decoded = decoded;

    next();
  });
};

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

    const db = client.db('edubridge');
    const usersCollection = db.collection('users');
    const tuitionsCollection = db.collection('tuitions');

    // signup route
    app.post('/signup', async (req, res) => {
      try {
        const existing = await usersCollection.findOne({ email: req.body.email });

        if (existing) {
          return res.status(200).json({ message: 'Email already exists' });
        }

        const result = await usersCollection.insertOne(req.body);
        res.send(result);
      } catch (error) {
        console.error('Signup error:', error);
        res.status(400).json({ message: 'Failed to create user!', error });
      }
    });

    // Tuitions API
    //post api
    app.post('/tuitions', verifyJwtToken, async (req, res) => {
      const { uid, userType } = req.decoded;

      if (userType !== 'student') {
        return res.status(403).send({ message: 'Only students can post tuitions' });
      }

      const body = req.body;
      body.studentId = uid;
      body.status = 'pending';
      body.createdAt = new Date();

      const result = await tuitionsCollection.insertOne(body);
      res.send(result);
    });

    // get api
    app.get('/tuitions', verifyJwtToken, async (req, res) => {
      const { uid, userType } = req.decoded;

      if (userType !== 'student') {
        return res.status(403).send({ message: 'Only students can get tuitions' });
      }
      const query = { studentId: uid };
      const cursor = tuitionsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // update api
    app.patch('/tuitions/:id', verifyJwtToken, async (req, res) => {
      const { uid, userType } = req.decoded;
      if (userType !== 'student') {
        return res.status(403).send({ message: 'Only students can update tuitions' });
      }

      const { title, classLevel, subject, location, budget } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id), studentId: uid };

      const updatedDoc = {
        $set: {
          title,
          classLevel,
          subject,
          location,
          budget,
        },
      };

      const result = await tuitionsCollection.updateOne(query, updatedDoc);

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: 'Tuition not found or not yours' });
      }

      res.send(result);
    });

    // Delete api
    app.delete('/tuitions/:id', verifyJwtToken, async (req, res) => {
      const { uid, userType } = req.decoded;
      if (userType !== 'student') {
        return res.status(403).send({ message: 'Only students can delete tuitions' });
      }
      const id = req.params.id;
      const query = { _id: new ObjectId(id), studentId: uid };

      if (result.deletedCount === 0) {
        return res.status(404).send({ message: 'Tuition not found or not owned by this student' });
      }

      const result = await tuitionsCollection.deleteOne(query);
      res.send(result);
    });

    //  JWT
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
          console.error('FATAL ERROR: ACCESS_TOKEN_SECRET is not defined.');
          return res.status(500).send({ message: 'Server configuration error.' });
        }

        const payload = { uid, userType: userRole };

        const token = jwt.sign(payload, secret, { expiresIn: '1h' });

        res.send({ token, userType: userRole });
      } catch (error) {
        console.error('JWT generation error:', error);
        res.status(500).send({ message: 'Failed to generate JWT', error: error.message });
      }
    });
  } catch (error) {
    console.error(error);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
