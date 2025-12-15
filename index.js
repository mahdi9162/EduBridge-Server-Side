import express, { application } from 'express';
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
    const tuitionApplications = db.collection('applications');

    // User Collections
    // signup route
    app.post('/signup', async (req, res) => {
      try {
        const existing = await usersCollection.findOne({ email: req.body.email });

        if (existing) {
          return res.status(200).json({ message: 'Email already exists' });
        }

        const body = req.body;
        body.createdAt = new Date();

        const result = await usersCollection.insertOne(body);
        res.send(result);
      } catch (error) {
        console.error('Signup error:', error);
        res.status(400).json({ message: 'Failed to create user!', error });
      }
    });
    // users get api
    app.get('/users', verifyJwtToken, async (req, res) => {
      const { userType } = req.decoded;

      if (userType !== 'admin') {
        return res.status(403).send({ message: 'Only admin can see users info!' });
      }

      try {
        const query = {};
        const result = await usersCollection.find(query).sort({ createdAt: -1 }).toArray();
        res.send(result);
      } catch (error) {
        console.log(error);
        res.status(500).send({ message: 'Failed to fetch users' });
      }
    });

    // get tutor api
    app.get('/public/tutors', async (req, res) => {
      try {
        const query = { userType: 'teacher' };
        const result = await usersCollection.find(query).sort({ createdAt: -1 }).toArray();
        res.send(result);
      } catch (error) {
        console.log(error);
        res.status(500).send({ message: 'Failed to fetch tutors' });
      }
    });

    // users update api by admin
    app.patch('/admin/users/:id', verifyJwtToken, async (req, res) => {
      const { userType: requestUserType } = req.decoded;

      if (requestUserType !== 'admin') {
        return res.status(403).send({ message: 'Only admin can update user profile' });
      }

      try {
        const { name, classLevel, teachingClass, subject, phone, userType: updatedUserType } = req.body;
        const id = req.params.id;

        const query = { _id: new ObjectId(id) };

        const updatedDoc = {
          $set: {
            name,
            classLevel,
            teachingClass,
            subject,
            phone,
            userType: updatedUserType,
          },
        };

        const result = await usersCollection.updateOne(query, updatedDoc);
        res.send(result);
      } catch (error) {
        console.log(error);
      }
    });

    // users delete api by admin
    app.delete('/admin/users/:id', verifyJwtToken, async (req, res) => {
      const { userType } = req.decoded;

      if (userType !== 'admin') {
        return res.status(403).send({ message: 'Only admin can delete user profile' });
      }

      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };

        const result = await usersCollection.deleteOne(query);

        if (result.deletedCount === 0) {
          return res.status(404).send({ message: 'User not found' });
        }

        res.send(result);
      } catch (error) {
        console.log(error);
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
      body.status = 'open';
      body.postStatus = 'pending';
      body.createdAt = new Date();

      const result = await tuitionsCollection.insertOne(body);
      res.send(result);
    });

    // get api
    app.get('/tuitions', verifyJwtToken, async (req, res) => {
      const { uid, userType } = req.decoded;

      if (userType !== 'student' && userType !== 'admin') {
        return res.status(403).send({ message: 'Only students and admin can get tuitions' });
      }
      const query = userType === 'student' ? { studentId: uid } : {};

      const result = await tuitionsCollection.find(query).sort({ createdAt: -1 }).toArray();
      res.send(result);
    });

    // get api for public
    app.get('/all-tuitions', async (req, res) => {
      const query = { status: 'open' };
      const cursor = tuitionsCollection
        .find(query, {
          projection: {
            studentId: 0,
          },
        })
        .sort({ createdAt: -1 });

      const result = await cursor.toArray();
      res.send(result);
    });

    // get tuition details api only for tutor
    app.get('/tuition-details/:id', verifyJwtToken, async (req, res) => {
      const { uid, userType } = req.decoded;

      if (userType !== 'teacher') {
        return res.status(403).send({ message: 'Only teacher can see tuition details!' });
      }

      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await tuitionsCollection.findOne(query);
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

    // tuition patch api for postStatus pending to approved or reject
    app.patch('/tuitions-status/:id', verifyJwtToken, async (req, res) => {
      const { uid, userType } = req.decoded;

      if (userType !== 'admin') {
        return res.status(403).send({ message: 'Only admin can approved or reject tuitions post!' });
      }

      const { postStatus } = req.body;

      if (!['approved', 'rejected'].includes(postStatus)) {
        return res.status(400).send({ message: 'Invalid status' });
      }

      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const updatedDoc = {
        $set: {
          postStatus,
        },
      };

      const result = await tuitionsCollection.updateOne(query, updatedDoc);

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: 'Tuition post not found' });
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

      const result = await tuitionsCollection.deleteOne(query);
      if (result.deletedCount === 0) {
        return res.status(404).send({ message: 'Tuition not found or not owned by this student' });
      }

      res.send(result);
    });

    // Application Collection
    // Tuition Application
    // post api
    app.post('/applications/:id', verifyJwtToken, async (req, res) => {
      try {
        const { uid, userType } = req.decoded;
        const { id: tuitionId } = req.params;

        if (userType !== 'teacher') {
          return res.status(403).send({ message: 'Only teacher can apply for tuitions!' });
        }

        const tuitionObjectId = new ObjectId(tuitionId);

        const tuition = await tuitionsCollection.findOne({ _id: tuitionObjectId });

        if (!tuition) {
          return res.status(404).send({ message: 'Tuition not found.' });
        }

        const studentId = tuition.studentId;

        const existing = await tuitionApplications.findOne({
          tuitionId: tuitionObjectId,
          tutorId: uid,
        });

        if (existing) {
          return res.status(409).send({
            message: 'You have already applied for this tuition.',
          });
        }
        const body = req.body;
        body.tutorId = uid;
        body.tuitionId = tuitionObjectId;
        body.studentId = studentId;
        body.applyStatus = 'pending';
        body.createdAt = new Date();

        const result = await tuitionApplications.insertOne(body);
        res.send(result);
      } catch (error) {
        console.log(error);
        return res.status(500).send({ message: 'Internal server error' });
      }
    });

    // get api for application collection- only for tutor
    app.get('/applications', verifyJwtToken, async (req, res) => {
      try {
        const { uid, userType } = req.decoded;

        if (userType !== 'teacher') {
          return res.status(403).send({ message: 'Only teacher can see their applicatios!' });
        }

        const result = await tuitionApplications.find({ tutorId: uid }).sort({ createdAt: -1 }).toArray();

        res.send(result);
      } catch (error) {
        console.log(error);
      }
    });

    // get application for student
    app.get('/tutor-applications', verifyJwtToken, async (req, res) => {
      try {
        const { uid, userType } = req.decoded;

        if (userType !== 'student') {
          return res.status(403).send({ message: 'Only student can see tutor applicatios!' });
        }

        const result = await tuitionApplications.find({ studentId: uid }).sort({ createdAt: -1 }).toArray();
        res.send(result);
      } catch (error) {
        console.log(error);
      }
    });

    // tutor status reject patch api
    app.patch('/applications/:id', verifyJwtToken, async (req, res) => {
      try {
        const { uid, userType } = req.decoded;

        if (userType !== 'student') {
          return res.status(403).send({ message: 'Only student can update application status!' });
        }

        const id = req.params.id;
        const { applyStatus } = req.body;

        if (!applyStatus) {
          return res.status(400).send({ message: 'applyStatus is required' });
        }

        const query = { _id: new ObjectId(id), studentId: uid };

        const updatedDoc = {
          $set: { applyStatus },
        };

        const result = await tuitionApplications.updateOne(query, updatedDoc);
        res.send(result);
      } catch (error) {
        console.log(error);
      }
    });

    // tutor status select patch api
    app.patch('/select-applications/:id', verifyJwtToken, async (req, res) => {
      try {
        const { uid, userType } = req.decoded;

        if (userType !== 'student') {
          return res.status(403).send({ message: 'Only student can update application status!' });
        }

        const id = req.params.id;
        const selectedId = new ObjectId(id);

        const selectedApplication = await tuitionApplications.findOne({ _id: selectedId, studentId: uid });

        if (!selectedApplication) {
          return res.status(404).send({ message: 'Application not found!' });
        }

        const tuitionId = selectedApplication.tuitionId;

        // tuition collection update
        await tuitionsCollection.updateOne(
          { _id: tuitionId, studentId: uid },
          {
            $set: {
              status: 'selected_pending_payment',
              selectedApplicationId: selectedId,
              selectedTutorId: selectedApplication.tutorId,
              selectedAt: new Date(),
            },
          }
        );

        // select one
        const selectResult = await tuitionApplications.updateOne(
          { _id: selectedId, studentId: uid },
          { $set: { applyStatus: 'selected_pending_payment', selectedAt: new Date() } }
        );

        // reject all
        const rejectOthersResult = await tuitionApplications.updateMany(
          {
            tuitionId,
            studentId: uid,
            applyStatus: 'pending',
            _id: { $ne: selectedId },
          },
          { $set: { applyStatus: 'rejected' } }
        );

        res.send({
          selectResult,
          rejectOthersResult,
        });
      } catch (error) {
        console.log(error);
      }
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
