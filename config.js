// TTN Dashboard – Konfiguration
// Fyll i dina uppgifter nedan och öppna index.html i en webbläsare.
// OBS: Lägg aldrig in riktiga API-nycklar i en publik git-repo.
const CONFIG = {
  cluster:         'eu1.cloud.thethings.network', // EU1 – ändra vid behov
  appId:           'DITT_APP_ID',                 // TTN Application ID
  apiKey:          'NNSXS.XXXXXXXXXX',            // TTN API-nyckel (API Key)
  password:        'admin',                        // Lösenord för dashboarden
  refreshInterval: 30000,                          // Auto-uppdatering (ms)
  historyLimit:    50,                             // Max historiska meddelanden per enhet
};
