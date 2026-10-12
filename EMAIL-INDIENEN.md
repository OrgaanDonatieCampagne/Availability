# Beschikbaarheid automatisch laten indienen (e-mail)

## Het probleem

GitHub Pages host alleen **statische bestanden**. Er draait geen server-code. Rechtstreeks een e-mail versturen vanuit JavaScript in de browser kan daarom alleen als het wachtwoord of een API-sleutel van een mailaccount in de (publieke) code staat. Dan kan iedereen die sleutel kopiëren en uit naam van Sensibiliseringscampagne orgaandonatie e-mails versturen. **Dat doen we dus niet.**

Daarom heeft de website nu een veilige standaardwerking:

1. de deelnemer klikt op **Download beschikbaarheidsbestand**;
2. de site toont de stappen om het bestand te mailen naar `VUL-JE-EMAIL-IN@voorbeeld.be`, met een knop die een vooraf ingevulde e-mail opent (de bijlage moet de deelnemer zelf toevoegen).

## Aanbevolen oplossing: Google Apps Script web app

| | |
|---|---|
| **Wat** | Een klein script (`apps-script-Code.gs`) dat bij Google draait onder het account **VUL-JE-EMAIL-IN@voorbeeld.be**. |
| **Kosten** | Gratis. Limiet voor een gewoon Gmail-account: **100 e-mailontvangers per dag** (ruim voldoende: 1 mail per indiening). |
| **Samenwerking met GitHub Pages** | De deelnemerspagina stuurt de JSON met `fetch()` naar de URL van de web app. Het script mailt het bestand als bijlage naar de coördinator en kan het ook in een Google Drive-map bewaren. |
| **Welke gegevens gaan naar buiten?** | Alleen het beschikbaarheidsbestand: voornaam, familienaam, periode, tijdvakken en tijdstip van indienen. Geen IP-logging door de site, geen cookies, geen andere persoonsgegevens. Het gebeurt pas nadat de deelnemer zelf op *Beschikbaarheid indienen* klikt; de pagina toont vooraf welke gegevens verzonden worden. |
| **Secrets** | **Er is geen enkel geheim nodig.** Het script draait al als het campagne-account. De web-app-URL is géén wachtwoord: wie hem kent, kan hoogstens een (gecontroleerd) beschikbaarheidsbestand naar de coördinator sturen. De instellingen (ontvanger, Drive-map) staan in de *Script properties* van het Apps Script-project, niet in GitHub. |
| **Beveiliging in het script** | Maximale grootte, strikte controle van het formaat (schema, datums, tijden, statussen), opgeschoonde namen en bestandsnamen, en een rate limit (max. 40 indieningen per 10 minuten) tegen spam. |

**Waarom deze keuze?** Het campagne-adres is al een Gmail-account. Er komt dus geen extra dienst of verwerker bij, je hebt geen API-sleutel nodig, het is gratis, en de bestanden komen meteen in de juiste mailbox (en eventueel in Drive) terecht.

### Alternatieven (niet aanbevolen voor nu)

- **Formspree / Getform** (formulier-naar-e-mail). Simpel, maar het gratis plan is beperkt (bij Formspree ± 50 inzendingen per maand en bijlagen alleen betalend). Bovendien loopt het via een extra externe verwerker.
- **Cloudflare Worker + Resend/Brevo** (serverless). Zeer goed en gratis tier, met de API-sleutel veilig als *Worker secret*. Wel technischer: je hebt een eigen domein nodig voor de afzender, plus een extra account.
- **EmailJS en vergelijkbare diensten met een "publieke sleutel" in JavaScript.** Die sleutel is vrij te kopiëren en misbruiken, dus **niet gebruiken**.

## Installatie (± 10 minuten)

1. Meld je aan met **VUL-JE-EMAIL-IN@voorbeeld.be** en ga naar <https://script.google.com>.
2. Klik **Nieuw project** en geef het de naam *Sensibiliseringscampagne orgaandonatie – indien-service*.
3. Vervang de inhoud van `Code.gs` door de inhoud van `apps-script-Code.gs` uit deze repository. Klik **Opslaan**.
4. *(Optioneel)* Maak in Google Drive een map *Sensibiliseringscampagne orgaandonatie*. Open ze en kopieer het ID uit de adresbalk (het deel na `/folders/`).
5. Ga in Apps Script naar **Projectinstellingen** (tandwiel) → **Scripteigenschappen** → **Eigenschap toevoegen**:
   - `RECIPIENT` = `VUL-JE-EMAIL-IN@voorbeeld.be` (of een ander adres dat de mails moet krijgen)
   - `DRIVE_FOLDER_ID` = het map-ID uit stap 4 (weglaten als je geen Drive-kopie wil)
6. Klik rechtsboven op **Implementeren → Nieuwe implementatie**. Kies bij het tandwiel het type **Web-app** en stel in:
   - *Uitvoeren als*: **Ik** (VUL-JE-EMAIL-IN@voorbeeld.be)
   - *Wie heeft toegang*: **Iedereen**
7. Klik **Implementeren** en geef toestemming (Google waarschuwt dat de app niet geverifieerd is. Dat is normaal voor je eigen script: kies *Geavanceerd → Ga naar … (onveilig)* → *Toestaan*).
8. Kopieer de **URL van de web-app** (eindigt op `/exec`).
9. Open in je GitHub-repository `config.js` en vul in:
   ```js
   submitEndpoint: 'https://script.google.com/macros/s/……/exec',
   ```
   Commit de wijziging. Na ± 1 minuut staat op stap 3 van de deelnemerspagina de knop **Beschikbaarheid indienen**. De downloadknop blijft altijd beschikbaar als reserve.
10. Test: dien een proefbestand in en controleer je mailbox (en de Drive-map).

**Script later aanpassen?** Ga naar *Implementeren → Implementaties beheren → potlood → Versie: Nieuwe versie → Implementeren*. De URL blijft dan dezelfde.

**Uitschakelen?** Maak `submitEndpoint` in `config.js` weer leeg (`''`), of archiveer de implementatie in Apps Script.

## Technische noot

De deelnemerspagina verstuurt `Content-Type: text/plain`. Zo is het een *simple request* zonder CORS-preflight, wat Apps Script vereist. Het antwoord is JSON (`{"ok":true}`). Lukt het indienen niet (geen internet, limiet bereikt), dan krijgt de student meteen de keuze om het bestand te downloaden.
