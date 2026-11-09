const { beforeUserCreated, HttpsError } = require('firebase-functions/v2/identity');
const { allowsDirectSignUp } = require('./allow');

exports.blockDirectPasswordSignUp = beforeUserCreated({ region: 'us-central1' }, (event) => {
  if (!allowsDirectSignUp(event)) throw new HttpsError('permission-denied', 'Direct sign-up is not available.');
});
