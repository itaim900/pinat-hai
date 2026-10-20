// Firebase web app settings: Firebase console → Project settings → Your apps → Web app.
// These values are not secret; the security rules in firestore.rules protect the data.
// To test against the local Firebase emulators instead, set projectId to ''.
export const firebaseConfig = {
  apiKey: 'AIzaSyDjoPLA_kXYp0Diw1Z_412GwOBktAfG2d0',
  authDomain: 'pinat-hai.firebaseapp.com',
  projectId: 'pinat-hai',
  storageBucket: 'pinat-hai.firebasestorage.app',
  messagingSenderId: '131942166916',
  appId: '1:131942166916:web:77e26c692f7a6b1bc22dd1',
};

// Name of the Firestore database inside the project (Firestore Database → database list).
export const FIRESTORE_DATABASE = 'pinat-hai';

// Public website address, used for the "join" link the teacher shares.
export const SITE_URL = 'https://itaim900.github.io/pinat-hai/';
