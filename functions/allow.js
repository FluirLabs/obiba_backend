// Sign-up is only open to Google accounts directly; email accounts must come through the API's Turnstile check.
function allowsDirectSignUp(event) {
  return event.credential?.providerId === 'google.com';
}

module.exports = { allowsDirectSignUp };
