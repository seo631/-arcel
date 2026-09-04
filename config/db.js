const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set — add it in Render under Environment, or in .env locally.');
  }
  mongoose.set('strictQuery', true);

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  } catch (err) {
    // Most common first-deploy issue: Atlas Network Access doesn't allow
    // Render's IPs yet. Surface that clearly instead of a raw stack trace.
    throw new Error(
      `Could not connect to MongoDB: ${err.message}\n` +
      `If this is a new deploy, check MongoDB Atlas → Network Access — add 0.0.0.0/0 ` +
      `(or Render's outbound IPs) to the allow list, and confirm the username/password in MONGODB_URI.`
    );
  }
  console.log('[db] Connected to MongoDB Atlas');
}

module.exports = connectDB;
