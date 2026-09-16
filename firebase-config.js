// Firebase Web configuration.
//
// >>> PUT YOUR PROJECT'S VALUES HERE <<<
// Get them from: Firebase Console > Project Settings (gear icon) > General tab
// > "Your apps" > Web app > SDK setup and configuration > "Config".
//
// This object is NOT a secret. It is a public client identifier that is meant
// to be shipped inside static site code (GitHub Pages included) - it tells
// the browser which Firebase project to talk to. It does not grant access by
// itself: access is controlled by Firebase Authentication (who can sign in)
// and Firestore Security Rules (what a signed-in user can read/write).
// This is different from a service-account key / private key, which must
// never be placed in client-side code - this file never needs one.
export const firebaseConfig = {
  apiKey: "AIzaSyAFFGbYrvyqR67vTpLYH5cRzpSz353Y56c",
  authDomain: "task-tracker-8bc67.firebaseapp.com",
  projectId: "task-tracker-8bc67",
  storageBucket: "task-tracker-8bc67.firebasestorage.app",
  messagingSenderId: "270393443991",
  appId: "1:270393443991:web:d1e004f0968445ae3e0bd2"
};
