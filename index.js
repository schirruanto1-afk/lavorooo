require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ===== Supabase =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===== Credenziali Google (default - le tue) =====
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// Client default (il tuo account)
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const docs  = google.docs({  version: 'v1', auth: oauth2Client });

// ===== Client Groq =====
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ===== LOG DIAGNOSTICO =====
function maschera(v) {
  if (!v) return 'MANCANTE';
  return `lunghezza=${v.length}, inizio="${v.slice(0, 6)}...", fine="...${v.slice(-6)}"`;
}
console.log('--- DIAGNOSTICA CREDENZIALI ---');
console.log('GOOGLE_CLIENT_ID:', maschera(CLIENT_ID));
console.log('GOOGLE_CLIENT_SECRET:', maschera(CLIENT_SECRET));
console.log('GOOGLE_REFRESH_TOKEN:', maschera(REFRESH_TOKEN));
console.log('GROQ_API_KEY:', maschera(process.env.GROQ_API_KEY));
console.log('SUPABASE_URL:', maschera(process.env.SUPABASE_URL));
console.log('-------------------------------');

// ===== FUNZIONE: Ottieni client Drive per un terapista =====
async function getDriveClientForTherapist(therapistId) {
  if (!therapistId) return drive;
  
  try {
    const { data, error } = await supabase
      .from('therapist_google_tokens')
      .select('*')
      .eq('therapist_id', therapistId)
      .single();
    
    if (error || !data) return drive;
    
    const userAuth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    userAuth.setCredentials({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    });
    
    if (Date.now() >= data.expiry_date) {
      try {
        const { credentials } = await userAuth.refreshAccessToken();
        await supabase.from('therapist_google_tokens').update({
          access_token: credentials.access_token,
          expiry_date: credentials.expiry_date,
        }).eq('therapist_id', therapistId);
      } catch (e) {
        console.log('Token scaduto, uso default');
        return drive;
      }
    }
    
    return google.drive({ version: 'v3', auth: userAuth });
  } catch (e) {
    return drive;
  }
}

// ===== ENDPOINT: Auth URL per collegare Drive =====
app.get('/api/google/auth-url', (req, res) => {
  const authClient = new google.auth.OAuth2(
    CLIENT_ID, 
    CLIENT_SECRET,
    'https://developers.google.com/oauthplayground' // Redirect URI
  );
  
  const authUrl = authClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  
  res.json({ success: true, url: authUrl });
});

// ===== ENDPOINT: Callback scambio codice =====
app.post('/api/google/callback', async (req, res) => {
  try {
    const { code, therapistId } = req.body;
    
    if (!code || !therapistId) {
      return res.status(400).json({ success: false, error: 'Manca code o therapistId' });
    }
    
    const authClient = new google.auth.OAuth2(
      CLIENT_ID, 
      CLIENT_SECRET,
      'https://developers.google.com/oauthplayground'
    );
    
    const { tokens } = await authClient.getToken(code);
    
    await supabase.from('therapist_google_tokens').upsert({
      therapist_id: therapistId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date || Date.now() + 3600 * 1000,
      updated_at: new Date(),
    });
    
    console.log('Google Drive collegato per terapista:', therapistId);
    res.json({ success: true, message: 'Google Drive collegato!' });
  } catch (error) {
    console.error('Errore callback:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== ENDPOINT: Verifica se Drive è collegato =====
app.get('/api/google/status', async (req, res) => {
  try {
    const therapistId = req.query.therapistId;
    
    if (!therapistId) {
      return res.json({ linked: false });
    }
    
    const { data } = await supabase
      .from('therapist_google_tokens')
      .select('*')
      .eq('therapist_id', therapistId)
      .single();
    
    res.json({ linked: !!data });
  } catch (error) {
    res.json({ linked: false });
  }
});

// ===== ENDPOINT: Scollega Google Drive =====
app.delete('/api/google/disconnect', async (req, res) => {
  try {
    const { therapistId } = req.body;
    
    await supabase
      .from('therapist_google_tokens')
      .delete()
      .eq('therapist_id', therapistId);
    
    res.json({ success: true, message: 'Google Drive scollegato' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== ENDPOINT: Lista file Drive =====
app.get('/api/drive/files', async (req, res) => {
  try {
    const therapistId = req.query.therapistId;
    console.log('--> Lista file Drive - terapista:', therapistId || 'default');
    
    const driveClient = await getDriveClientForTherapist(therapistId);
    
    const response = await driveClient.files.list({
      pageSize: 50,
      fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink)',
      orderBy: 'modifiedTime desc',
    });
    
    console.log('--> Trovati', response.data.files?.length || 0, 'file');
    
    res.json({ 
      success: true, 
      files: response.data.files || [] 
    });
    
  } catch (error) {
    console.error('Errore lista file Drive:', error.message);
    
    if (error.message.includes('invalid_grant')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Token Google scaduto. Ricollega Google Drive dalle impostazioni.' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ===== ENDPOINT: Scarica file da Drive =====
app.get('/api/drive/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const therapistId = req.query.therapistId;
    
    console.log('--> Download file:', fileId);
    
    const driveClient = await getDriveClientForTherapist(therapistId);
    
    const metadata = await driveClient.files.get({
      fileId: fileId,
      fields: 'name, mimeType, size',
    });
    
    const fileName = metadata.data.name || 'file';
    const mimeType = metadata.data.mimeType || 'application/octet-stream';
    
    console.log('--> File:', fileName, '(', mimeType, ')');
    
    const file = await driveClient.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(fileName) + '"');
    
    file.data.pipe(res);
    
  } catch (error) {
    console.error('Errore download file:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ===== ENDPOINT: Info file =====
app.get('/api/drive/info/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const therapistId = req.query.therapistId;
    
    const driveClient = await getDriveClientForTherapist(therapistId);
    
    const response = await driveClient.files.get({
      fileId: fileId,
      fields: 'id, name, mimeType, size, modifiedTime, webViewLink',
    });
    
    res.json({ 
      success: true, 
      file: response.data 
    });
    
  } catch (error) {
    console.error('Errore info file:', error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ===== Endpoint principale =====
app.post('/api/genera', async (req, res) => {
  try {
    const { paziente, richiesta } = req.body;

    if (!paziente || !paziente.nome || !paziente.cognome) {
      return res.status(400).json({ success: false, error: 'Dati paziente mancanti (nome/cognome).' });
    }

    const richiestaFinale = richiesta?.trim() ||
      'Genera una cartella clinica completa con sezioni per anamnesi, diagnosi, obiettivi terapeutici e note di seduta';

    console.log('--> Richiesta per', paziente.nome, paziente.cognome, ':', richiestaFinale);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'Sei un assistente che aiuta uno psicoterapeuta a redigere documenti clinici professionali in italiano. Scrivi in modo chiaro, professionale e clinicamente appropriato. Non inventare informazioni cliniche specifiche non fornite: se mancano dati, lascia segnaposto tra parentesi quadre (es. [da completare]). Restituisci SOLO il testo del documento, senza markdown, senza intestazioni tipo "Ecco il documento", pronto per essere inserito in un Google Doc.'
        },
        {
          role: 'user',
          content: 'Paziente: ' + paziente.nome + ' ' + paziente.cognome + '\nTipo di terapia: ' + (paziente.tipo_terapia || 'non specificato') + '\nNote generali sul paziente: ' + (paziente.note || 'nessuna nota disponibile') + '\n\nRichiesta dello specialista: ' + richiestaFinale
        }
      ],
      temperature: 0.4,
      max_tokens: 2048,
    });

    const testoGenerato = completion.choices[0]?.message?.content?.trim();

    if (!testoGenerato) {
      throw new Error('Groq non ha restituito alcun contenuto.');
    }

    console.log('--> Testo generato (' + testoGenerato.length + ' caratteri), creo il documento...');

    const nuovoDoc = await docs.documents.create({
      requestBody: {
        title: paziente.nome + ' ' + paziente.cognome + ' - ' + new Date().toLocaleDateString('it-IT'),
      },
    });

    const nuovoDocId = nuovoDoc.data.documentId;

    await docs.documents.batchUpdate({
      documentId: nuovoDocId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: testoGenerato,
            },
          },
        ],
      },
    });

    const info = await drive.files.get({
      fileId: nuovoDocId,
      fields: 'webViewLink',
    });

    console.log('--> Documento creato:', info.data.webViewLink);
    res.json({ success: true, url: info.data.webViewLink });

  } catch (error) {
    console.error('Errore:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== Endpoint ask AI =====
app.post('/api/ask', async (req, res) => {
  try {
    const { query, context } = req.body;

    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Campo "query" mancante.' });
    }

    console.log('--> Domanda AI dashboard:', query);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'Sei un assistente per uno studio terapeutico. Hai accesso ai dati dei pazienti forniti nel contesto. Rispondi in italiano in modo conciso e utile. Se trovi dati pertinenti, mostrali chiaramente. Contesto dati: ' + (context || 'nessun contesto fornito')
        },
        { role: 'user', content: query }
      ],
      max_tokens: 500,
      temperature: 0.3,
    });

    const risposta = completion.choices[0]?.message?.content?.trim() ?? 'Nessuna risposta disponibile.';
    res.json({ answer: risposta });

  } catch (error) {
    console.error('Errore /api/ask:', error.message);
    res.status(500).json({ error: error.message, answer: 'Errore nella generazione della risposta.' });
  }
});

// ===== Health check =====
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    google: {
      clientId: CLIENT_ID ? 'configurato' : 'mancante',
      clientSecret: CLIENT_SECRET ? 'configurato' : 'mancante',
      refreshToken: REFRESH_TOKEN ? 'configurato' : 'mancante',
    },
    supabase: process.env.SUPABASE_URL ? 'configurato' : 'mancante',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server attivo sulla porta ' + PORT);
});
