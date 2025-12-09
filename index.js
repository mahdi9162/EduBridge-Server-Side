import express from 'express';
import dotenv from 'dotenv';
import mongodb, { MongoClient } from 'mongodb';
dotenv.config();
const app = express();
const port = process.env.PORT || '3000';
const client = new MongoClient(process.env.DATABASE_URL);

app.use(express.json());

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
  } catch (error) {
    console.error(error);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
