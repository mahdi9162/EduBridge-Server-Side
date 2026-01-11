import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import { createRequire } from 'module';
import Stripe from 'stripe';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const site = process.env.SITE_DOMAIN || 'http://localhost:5173';

const stripe = new Stripe(process.env.STRIPE_SECRET);

// ---------- middleware ----------
app.use(express.json());

// CORS (serverless-safe)
app.use(
  cors({
    origin: [site, 'http://localhost:5173'],
    credentials: true,
  })
);

// ---------- JWT middleware ----------
const verifyJwtToken = (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) return res.status(401).send({ message: 'Unauthorized access' });

  const idToken = token.split(' ')[1];

  jwt.verify(idToken, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) return res.status(403).send({ message: 'Forbidden access' });

    req.decoded = decoded;
    next();
  });
};

// ---------- Firebase Admin ----------
const require = createRequire(import.meta.url);
const admin = require('firebase-admin');

const decoded = Buffer.from(process.env.FB_SERVICE_KEY || '', 'base64').toString('utf8');
const serviceAccount = decoded ? JSON.parse(decoded) : null;

if (!admin.apps.length && serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// ---------- MongoDB ----------
const client = new MongoClient(process.env.DATABASE_URL);

let dbReady = false;
let usersCollection;
let tuitionsCollection;
let tuitionApplications;
let paymentsCollection;

async function initDB() {
  if (dbReady) return;

  await client.connect();
  const db = client.db('edubridge');

  usersCollection = db.collection('users');
  tuitionsCollection = db.collection('tuitions');
  tuitionApplications = db.collection('applications');
  paymentsCollection = db.collection('payments');

  dbReady = true;
  console.log('Database Connected!');
}

// every request tries to ensure DB ready (safe in serverless)
app.use(async (req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('DB init error:', err);
    res.status(503).send({ message: 'Database not ready' });
  }
});

// ---------- Health route ----------
app.get('/', (req, res) => {
  res.send({
    status: 'ok',
    vercel: process.env.VERCEL === '1',
    dbConnected: dbReady,
  });
});

// ========================= ROUTES =========================

// signup
app.post('/signup', async (req, res) => {
  try {
    const existing = await usersCollection.findOne({ email: req.body.email });

    if (existing) {
      return res.status(409).json({ message: 'Email already exists' });
    }

    const body = req.body;
    body.createdAt = new Date();

    const result = await usersCollection.insertOne(body);
    res.send(result);
  } catch (error) {
    console.error('Signup error:', error);
    res.status(400).json({ message: 'Failed to create user!', error: error?.message });
  }
});

// users (admin only)
app.get('/users', verifyJwtToken, async (req, res) => {
  const { userType } = req.decoded;

  if (userType !== 'admin') {
    return res.status(403).send({ message: 'Only admin can see users info!' });
  }

  try {
    const result = await usersCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: 'Failed to fetch users' });
  }
});

// get users (me)
app.get('/user/me', verifyJwtToken, async (req, res) => {
  const { uid } = req.decoded;

  try {
    const result = await usersCollection.findOne({ firebaseUID: uid });

    if (!result) return res.status(404).send({ message: 'User not found' });
    return res.send(result);
  } catch (error) {
    console.log(error);
    return res.status(500).send({ message: 'Failed to fetch user' });
  }
});

// update user (me)
app.patch('/user/me', verifyJwtToken, async (req, res) => {
  const { uid, userType } = req.decoded;

  try {
    const query = { firebaseUID: uid };
    const { name, classLevel, teachingClass, subject, phone, location } = req.body;

    const updatedDoc = {
      $set: {
        name,
        classLevel,
        teachingClass,
        subject,
        phone,
        location,
      },
    };

    // undefined not updated
    Object.keys(updatedDoc.$set).forEach((key) => {
      if (updatedDoc.$set[key] === undefined) delete updatedDoc.$set[key];
    });

    if (Object.keys(updatedDoc.$set).length === 0) {
      return res.status(400).send({ message: 'Nothing to update' });
    }

    const result = await usersCollection.updateOne(query, updatedDoc);
    res.send(result);
  } catch (error) {
    console.log(error);
    return res.status(500).send({ message: 'Failed to update user profile' });
  }
});

// update user profile picture (me)
app.patch('/user/me/photo', verifyJwtToken, async (req, res) => {
  const { uid } = req.decoded;
  try {
    const { photoURL } = req.body;

    if (!photoURL) return res.status(400).send({ message: 'photoURL required' });

    const result = await usersCollection.updateOne({ firebaseUID: uid }, { $set: { photoURL } });

    res.send(result);
  } catch (error) {
    console.log(error);
    return res.status(500).send({ message: 'Failed to update user photo' });
  }
});

// delete user (me)
app.delete('/user/me', verifyJwtToken, async (req, res) => {
  const { uid } = req.decoded;

  try {
    const result = await usersCollection.deleteOne({ firebaseUID: uid });

    if (result.deletedCount === 0) {
      return res.status(404).send({ message: 'User not found' });
    }

    return res.send({ message: 'User deleted', result });
  } catch (error) {
    console.log(error);
    return res.status(500).send({ message: 'Failed to delete user' });
  }
});

// public tutors
app.get('/public/tutors', async (req, res) => {
  try {
    const result = await usersCollection.find({ userType: 'teacher' }).sort({ createdAt: -1 }).toArray();
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: 'Failed to fetch tutors' });
  }
});

// update user (admin)
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
    res.status(500).send({ message: 'Failed to update user' });
  }
});

// delete user (admin)
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
    res.status(500).send({ message: 'Failed to delete user' });
  }
});

// post tuitions (student)
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

// get tuitions (student/admin)
app.get('/tuitions', verifyJwtToken, async (req, res) => {
  const { uid, userType } = req.decoded;

  if (userType !== 'student' && userType !== 'admin') {
    return res.status(403).send({ message: 'Only students and admin can get tuitions' });
  }

  const query = userType === 'student' ? { studentId: uid } : {};
  const result = await tuitionsCollection.find(query).sort({ createdAt: -1 }).toArray();
  res.send(result);
});

// get all public tuitions
app.get('/all-tuitions', async (req, res) => {
  try {
    const cursor = tuitionsCollection
      .find(
        { status: 'open' },
        {
          projection: { studentId: 0 },
        }
      )
      .sort({ createdAt: -1 });

    const result = await cursor.toArray();
    res.send(result);
  } catch (e) {
    console.error(e);
    res.status(500).send({ message: 'Failed to fetch tuitions' });
  }
});

// tuition details (teacher)
app.get('/tuition-details/:id', verifyJwtToken, async (req, res) => {
  const { userType } = req.decoded;

  if (userType !== 'teacher') {
    return res.status(403).send({ message: 'Only teacher can see tuition details!' });
  }

  const id = req.params.id;
  const result = await tuitionsCollection.findOne({ _id: new ObjectId(id) });
  res.send(result);
});

// update tuition (student)
app.patch('/tuitions/:id', verifyJwtToken, async (req, res) => {
  const { uid, userType } = req.decoded;

  if (userType !== 'student') {
    return res.status(403).send({ message: 'Only students can update tuitions' });
  }

  const { title, classLevel, subject, location, budget } = req.body;
  const id = req.params.id;

  const query = { _id: new ObjectId(id), studentId: uid };

  const updatedDoc = {
    $set: { title, classLevel, subject, location, budget },
  };

  const result = await tuitionsCollection.updateOne(query, updatedDoc);

  if (result.matchedCount === 0) {
    return res.status(404).send({ message: 'Tuition not found or not yours' });
  }

  res.send(result);
});

// approve/reject tuition post (admin)
app.patch('/tuitions-status/:id', verifyJwtToken, async (req, res) => {
  const { userType } = req.decoded;

  if (userType !== 'admin') {
    return res.status(403).send({ message: 'Only admin can approved or reject tuitions post!' });
  }

  const { postStatus } = req.body;

  if (!['approved', 'rejected'].includes(postStatus)) {
    return res.status(400).send({ message: 'Invalid status' });
  }

  const id = req.params.id;

  const result = await tuitionsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { postStatus } });

  if (result.matchedCount === 0) {
    return res.status(404).send({ message: 'Tuition post not found' });
  }

  res.send(result);
});

// delete tuition (student)
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

// apply for tuition (teacher)
app.post('/applications/:id', verifyJwtToken, async (req, res) => {
  try {
    const { uid, userType } = req.decoded;
    const { id: tuitionId } = req.params;

    if (userType !== 'teacher') {
      return res.status(403).send({ message: 'Only teacher can apply for tuitions!' });
    }

    const tuitionObjectId = new ObjectId(tuitionId);
    const tuition = await tuitionsCollection.findOne({ _id: tuitionObjectId });

    if (!tuition) return res.status(404).send({ message: 'Tuition not found.' });

    const existing = await tuitionApplications.findOne({
      tuitionId: tuitionObjectId,
      tutorId: uid,
    });

    if (existing) {
      return res.status(409).send({ message: 'You have already applied for this tuition.' });
    }

    const body = req.body;
    body.tutorId = uid;
    body.tuitionId = tuitionObjectId;
    body.studentId = tuition.studentId;
    body.applyStatus = 'pending';
    body.createdAt = new Date();

    const result = await tuitionApplications.insertOne(body);
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: 'Internal server error' });
  }
});

// tutor applications (teacher)
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
    res.status(500).send({ message: 'Server error' });
  }
});

// student view tutor applications (student)
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
    res.status(500).send({ message: 'Server error' });
  }
});

// student updates application status
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
    const result = await tuitionApplications.updateOne(query, { $set: { applyStatus } });

    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: 'Server error' });
  }
});

// payment success update
app.patch('/payment-success', async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).send({ message: 'session_id missing' });

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.status(400).send({ message: 'Payment not completed' });
    }

    const { tuitionId, applicationId, tutorId, studentId, tuitionTitle, studentName, studentEmail, salary, tutorAmount, adminFee } =
      session.metadata || {};

    if (!tuitionId || !applicationId) {
      return res.status(400).send({ message: 'metadata missing' });
    }

    const tuition = await tuitionsCollection.findOne({ _id: new ObjectId(tuitionId) });

    const appQuery = { _id: new ObjectId(applicationId) };
    const tuitionQuery = { _id: new ObjectId(tuitionId) };

    const appUpdatedDoc = {
      $set: {
        tuitionTitle,
        studentName,
        studentEmail,
        salary,
        subject: tuition?.subject,
        location: tuition?.location,
        classLevel: tuition?.classLevel,
        applyStatus: 'selected',
        paymentStatus: 'paid',
        paidAt: new Date(),
      },
    };

    const tuitionUpdatedDoc = {
      $set: {
        salary,
        status: 'selected',
        paymentStatus: 'paid',
        paidAt: new Date(),
      },
    };

    const paymentDoc = {
      tuitionId,
      applicationId,
      tutorId,
      studentId,
      tuitionTitle,
      studentName,
      studentEmail,
      amount: salary,
      tutorAmount,
      adminFee,
      status: 'paid',
      paidAt: new Date(),
      stripeSessionId: session.id,
    };

    await paymentsCollection.updateOne({ stripeSessionId: session.id }, { $setOnInsert: paymentDoc }, { upsert: true });

    const appResult = await tuitionApplications.updateOne(appQuery, appUpdatedDoc);
    const tuitionResult = await tuitionsCollection.updateOne(tuitionQuery, tuitionUpdatedDoc);

    return res.send({ appResult, tuitionResult });
  } catch (e) {
    console.error(e);
    res.status(500).send({ message: 'Server error' });
  }
});

// payment history
app.get('/payment-history', verifyJwtToken, async (req, res) => {
  try {
    const { uid, userType } = req.decoded;

    if (!['student', 'teacher', 'admin'].includes(userType)) {
      return res.status(403).send({ message: 'Only student, teacher and admin can see payments history' });
    }

    const filter = userType === 'admin' ? {} : userType === 'teacher' ? { tutorId: uid } : { studentId: uid };
    const result = await paymentsCollection.find(filter).sort({ paidAt: -1 }).toArray();
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: 'Server error' });
  }
});

// create checkout session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const paymentInfo = req.body;
    const amount = parseInt(paymentInfo.amount, 10) * 100;

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: 'bdt',
            unit_amount: amount,
            product_data: { name: paymentInfo.tuitionTitle },
          },
          quantity: 1,
        },
      ],
      customer_email: paymentInfo.studentEmail,
      mode: 'payment',
      metadata: {
        tuitionId: paymentInfo.tuitionId,
        applicationId: paymentInfo.applicationId,
        tutorId: paymentInfo.tutorId,
        studentId: paymentInfo.studentId,
        tuitionTitle: paymentInfo.tuitionTitle,
        studentName: paymentInfo.studentName,
        studentEmail: paymentInfo.studentEmail,
        salary: paymentInfo.amount,
        tutorAmount: paymentInfo.tutorAmount,
        adminFee: paymentInfo.adminFee,
      },
      success_url: `${site}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/dashboard/payment-cancelled`,
    });

    res.send({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).send({ message: 'Failed to create checkout session' });
  }
});

// tutor updates their application
app.patch('/application/:id', verifyJwtToken, async (req, res) => {
  try {
    const { uid, userType } = req.decoded;

    if (userType !== 'teacher') {
      return res.status(403).send({ message: 'Only tutor can update their application' });
    }

    const { qualification, experience, expectedSalary } = req.body;
    const id = req.params.id;

    const query = { _id: new ObjectId(id), tutorId: uid };
    const updatedDoc = { $set: { qualification, experience, expectedSalary } };

    const result = await tuitionApplications.updateOne(query, updatedDoc);

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: 'Application not found or not yours' });
    }

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: 'Server error' });
  }
});

// tutor delete application
app.delete('/application/:id', verifyJwtToken, async (req, res) => {
  try {
    const { uid, userType } = req.decoded;

    if (userType !== 'teacher') {
      return res.status(403).send({ message: 'Only tutor can delete their application' });
    }

    const id = req.params.id;
    const query = { _id: new ObjectId(id), tutorId: uid };

    const result = await tuitionApplications.deleteOne(query);

    if (result.deletedCount === 0) {
      return res.status(404).send({ message: 'Application not found or not owned by this tutor' });
    }

    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: 'Server error' });
  }
});

// JWT from firebase token
app.post('/api/auth/jwt', async (req, res) => {
  try {
    const firebaseToken = req.body.token;
    if (!firebaseToken) return res.status(400).send({ message: 'Token is missing in request body' });

    const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    const uid = decodedToken.uid;

    const user = await usersCollection.findOne({ firebaseUID: uid });
    if (!user) return res.status(404).send({ message: 'User profile not found in database' });

    const secret = process.env.ACCESS_TOKEN_SECRET;
    if (!secret) return res.status(500).send({ message: 'Server configuration error.' });

    const payload = { uid, userType: user.userType };
    const token = jwt.sign(payload, secret, { expiresIn: '1h' });

    res.send({ token, userType: user.userType });
  } catch (error) {
    console.error('JWT generation error:', error);
    res.status(500).send({ message: 'Failed to generate JWT', error: error.message });
  }
});

// local only
const isVercel = process.env.VERCEL === '1';
if (!isVercel) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

export default app;
