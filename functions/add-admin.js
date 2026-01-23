#!/usr/bin/env node
/**
 * Add a user as admin in Firebase RTDB
 * Usage: node add-admin.js <uid>
 */

const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin SDK
const serviceAccountPath = path.join(__dirname, 'service-account-key.json');

try {
  const serviceAccount = require(serviceAccountPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://theta-inkwell-448908-g9-default-rtdb.asia-southeast1.firebasedatabase.app'
  });
  console.log('✓ Firebase Admin SDK initialized');
} catch (error) {
  console.error('Failed to initialize Firebase Admin SDK');
  console.error('Make sure service-account-key.json exists in this directory');
  console.error('Error:', error.message);
  process.exit(1);
}

const uid = process.argv[2];
if (!uid) {
  console.error('Usage: node add-admin.js <uid>');
  process.exit(1);
}

async function addAdmin() {
  const db = admin.database();

  console.log(`\nAdding ${uid} as admin...`);

  // Add to production /admins
  await db.ref(`admins/${uid}`).set(true);
  console.log(`✓ Added to /admins`);

  // Add to test /test/admins
  await db.ref(`test/admins/${uid}`).set(true);
  console.log(`✓ Added to /test/admins`);

  // Verify
  const prodAdmin = await db.ref(`admins/${uid}`).once('value');
  const testAdmin = await db.ref(`test/admins/${uid}`).once('value');

  console.log('\nVerification:');
  console.log(`Production admin: ${prodAdmin.val() === true ? '✅' : '❌'}`);
  console.log(`Test admin: ${testAdmin.val() === true ? '✅' : '❌'}`);

  console.log('\n✓ Done! You can now access admin features in the Controller.');
  console.log('  → Restart the Controller app to refresh Firebase auth cache');

  process.exit(0);
}

addAdmin().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
