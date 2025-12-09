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


  } catch (error) {
    console.error(error);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
