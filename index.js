require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const Groq = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());

// ===== Credenziali Google =====
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const docs  = google.docs({  version: 'v1', auth: oauth2Client });

let userTokens = null;

// ===== Client Groq =====
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ===== LOG =====
console.log('--- AVVIO SERVER ---');
console.log('Google Client ID:', CLIENT_ID ? 'OK' : 'MANCANTE');
console.log('Google Refresh Token:', REFRESH_TOKEN ? 'OK' : 'MANCANTE');
console.log('Groq API Key:', process.env.GROQ_API_KEY ? 'OK' : 'MANCANTE');
console.log('-------------------');

// ==========================================
// LOGIN GOOGLE
// ==========================================
app.get('/api/google/login', (req, res) => {
  const authClient = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    'https://studio-backend-kzx7.onrender.com/api/google/callback-web'
  );
  const authUrl = authClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/documents',
    ],
  });
  res.redirect(authUrl);
});

// ==========================================
// CALLBACK DOPO LOGIN
// ==========================================
app.get('/api/google/callback-web', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('<h1 style="color:red;">Errore: codice mancante</h1>');

  try {
    const authClient = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET,
      'https://studio-backend-kzx7.onrender.com/api/google/callback-web'
    );
    const { tokens } = await authClient.getToken(code);
    userTokens = tokens;

    const userAuth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    userAuth.setCredentials(tokens);
    const userDrive = google.drive({ version: 'v3', auth: userAuth });
    const files = await userDrive.files.list({ pageSize: 20, fields: 'files(name)' });
    const fileList = (files.data.files || []).map(f => '<li>📄 ' + f.name + '</li>').join('');

    res.send(
      '<html><head><style>body{font-family:sans-serif;padding:30px;text-align:center;}ul{text-align:left;max-width:400px;margin:20px auto;}</style></head>' +
      '<body>' +
      '<h1 style="color:green;">✅ Collegato al tuo Google Drive!</h1>' +
      '<p>I tuoi file:</p>' +
      '<ul>' + (fileList || '<li>Nessun file trovato</li>') + '</ul>' +
      '<p style="margin-top:30px;color:#666;">Ora puoi chiudere questa finestra e cliccare di nuovo su ☁️ Drive nell\'app.</p>' +
      '<button onclick="window.close()" style="padding:12px 30px;background:#4285F4;color:white;border:none;border-radius:8px;font-size:16px;cursor:pointer;">✅ Fatto! Chiudi</button>' +
      '</body></html>'
    );
  } catch (error) {
    res.send('<h1 style="color:red;">Errore</h1><p>' + error.message + '</p>');
  }
});

// ==========================================
// LISTA FILE DRIVE — ora supporta ?folderId=
// ==========================================
app.get('/api/drive/files', async (req, res) => {
  try {
    let driveClient = drive;
    if (userTokens) {
      const userAuth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
      userAuth.setCredentials(userTokens);
      driveClient = google.drive({ version: 'v3', auth: userAuth });
    }

    // Se viene passato ?folderId= mostra il contenuto di quella cartella,
    // altrimenti mostra la root (My Drive)
    const folderId = req.query.folderId || 'root';
    const query = `'${folderId}' in parents and trashed = false`;

    const response = await driveClient.files.list({
      q: query,
      pageSize: 100,
      fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink)',
      orderBy: 'folder,name', // cartelle prima, poi file in ordine alfabetico
    });

    const files = (response.data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size,
      modifiedTime: f.modifiedTime,
      webViewLink: f.webViewLink,
      // true se è una cartella, così il frontend può distinguerla
      isFolder: f.mimeType === 'application/vnd.google-apps.folder',
    }));

    res.json({ success: true, files, folderId });

  } catch (error) {
    console.error('Errore /api/drive/files:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// SCARICA FILE
// ==========================================
app.get('/api/drive/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    let driveClient = drive;
    if (userTokens) {
      const userAuth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
      userAuth.setCredentials(userTokens);
      driveClient = google.drive({ version: 'v3', auth: userAuth });
    }

    const metadata = await driveClient.files.get({
      fileId,
      fields: 'name, mimeType',
    });

    const file = await driveClient.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Type', metadata.data.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(metadata.data.name || 'file') + '"');
    file.data.pipe(res);

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// LOGOUT
// ==========================================
app.get('/api/google/logout', (req, res) => {
  userTokens = null;
  res.json({ success: true, message: 'Tornato al Drive predefinito' });
});

// ==========================================
// GENERA DOCUMENTO AI
// ==========================================
app.post('/api/genera', async (req, res) => {
  try {
    const { paziente, richiesta } = req.body;
    if (!paziente || !paziente.nome || !paziente.cognome) {
      return res.status(400).json({ success: false, error: 'Dati paziente mancanti.' });
    }

    const richiestaFinale = richiesta?.trim() || 'Genera una cartella clinica completa';

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'Sei un assistente che aiuta uno psicoterapeuta a redigere documenti clinici professionali in italiano. Restituisci SOLO il testo del documento, senza markdown.'
        },
        {
          role: 'user',
          content: 'Paziente: ' + paziente.nome + ' ' + paziente.cognome + '\nTerapia: ' + (paziente.tipo_terapia || 'N/D') + '\nNote: ' + (paziente.note || 'N/D') + '\n\nRichiesta: ' + richiestaFinale
        }
      ],
      temperature: 0.4,
      max_tokens: 2048,
    });

    const testo = completion.choices[0]?.message?.content?.trim();
    if (!testo) throw new Error('Nessun contenuto generato');

    const nuovoDoc = await docs.documents.create({
      requestBody: { title: paziente.nome + ' ' + paziente.cognome + ' - ' + new Date().toLocaleDateString('it-IT') },
    });

    await docs.documents.batchUpdate({
      documentId: nuovoDoc.data.documentId,
      requestBody: { requests: [{ insertText: { location: { index: 1 }, text: testo } }] },
    });

    const info = await drive.files.get({ fileId: nuovoDoc.data.documentId, fields: 'webViewLink' });
    res.json({ success: true, url: info.data.webViewLink });

  } catch (error) {
    console.error('Errore /api/genera:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// ASK AI
// ==========================================
app.post('/api/ask', async (req, res) => {
  try {
    const { query, context } = req.body;
    if (!query?.trim()) return res.status(400).json({ error: 'Query mancante.' });

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'Assistente studio terapeutico. Contesto: ' + (context || 'nessuno') },
        { role: 'user', content: query }
      ],
      max_tokens: 500,
      temperature: 0.3,
    });

    res.json({ answer: completion.choices[0]?.message?.content?.trim() ?? 'Nessuna risposta.' });

  } catch (error) {
    console.error('Errore /api/ask:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', userLoggedIn: !!userTokens });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server attivo sulla porta ' + PORT));
