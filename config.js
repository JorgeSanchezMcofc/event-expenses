// Public settings only. Neither value is a secret: the API checks every request's Google
// sign-in token on the server and only answers ALLOWED_EMAIL (set in Apps Script).
window.APP_CONFIG = {
  // Apps Script web app URL (Deploy > Manage deployments > Web app URL, ends in /exec)
  apiUrl: 'https://script.google.com/macros/s/PASTE_DEPLOYMENT_ID/exec',
  // OAuth 2.0 Client ID (Google Cloud Console > APIs & Services > Credentials)
  clientId: '405999258607-b1dtkavsbac2ba99nakcqf9srjrcnlsj.apps.googleusercontent.com',
  defaultFy: '26-27',
  loginHint: 'jsanchez@mcallenchamber.com'
};
