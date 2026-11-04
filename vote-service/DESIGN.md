# Vote-Service: Design-Erklärung
Das Aufsetzen des SMS-Vote-Services war ein spannendes Projekt, bei welchem ich Ihnen einmal aufzeigen wollte, was für mich mit KI-Zusammenarbeit möglich ist. Im Rahmen dessen gibt es natürlich verschiedene Architekturen, welche ihre Vor- und Nachteile haben.
Auf Ihrer Seite habe ich gesehen, dass Sie mit CrowdVoting arbeiten.
Die Herausforderungen eines Voting-Services bestehen in meinen Augen aus den folgenden:
1) Wie setze ich "eine Stimme" pro Person durch?
2) Wie verarbeitet das Backend Stimmen?
3) Welche Angriffsmöglichkeiten gibt es und wie schütze ich mich gegen solche?
 

## SMS-Validierung und Cookie-Identität, um eine Stimme pro Nummer durchzusetzen.
Ich habe mich für SMS-Validierung + Cookie-Identität entschieden, damit ich möglichst zuverlässig je Nummer eine Stimme garantiere. Das wird umgesetzt durch server-issued Cookies, welche mit einem HMAC signiert werden. Das schützt gegen mehrfaches Voting aus demselben Browser. Hierbei kann natürlich ein anderer Browser verwendet werden, um dies zu umgehen, daher als Add-on eine SMS-Verifizierung durch einen 6-stelligen Code ans Handy. Der Code und die Handynummer liegen nur als HMAC in der Datenbank. Hierbei ist es jedoch so, dass eine Stimme nicht im Nachhinein verändert werden kann.
Alternativen wären IP-Adressen oder E-Mail.

## Backendverarbeitung durch zwei Schritte.
Ich habe mich hierbei für ein System mit zwei Schritten und zwei Tabellen entschieden. Der erste Schritt ist `POST /votes`.
Bevor hier etwas gespeichert oder eine SMS verschickt wird, läuft die Anfrage durch mehrere Prüfungen. Diese sind: Rate-Limit pro IP-Adresse, Cookie-Identität, nur JSON, höchstens 1 KB, Form der Anfrage und Telefonnummer,
höchstens drei Codes pro Nummer und Stunde. Zuletzt fragt der Server die Datenbank, ob dieser Wähler oder diese Nummer
schon abgestimmt hat. Erst dann wird eine vorläufige
Stimme angelegt (`pending_votes`) und der Code verschickt.

Der zweite Schritt ist `POST /votes/confirm`. Nach denselben Grundprüfungen wird hier nur noch der Code geprüft: Er ist
10 Minuten gültig, nach fünf falschen Versuchen wird die vorläufige Stimme gelöscht. Erst mit dem richtigen SMS-Code wird
die Stimme in einer Transaktion zu den gezählten Stimmen (`votes`) verschoben. Gezählt wird nur diese Tabelle, das
Ergebnis enthält also nur bestätigte Stimmen.

## Angriffsmöglichkeiten und Schutz
Hier arbeite ich nach dem Prinzip von Schichten. Sprich, dass ich den Schutz dort ansetze, wo die vorige Schicht versagt:
- **Mehrfach abstimmen:** Ein neuer Browser umgeht das Cookie, aber nicht die SMS-Bestätigung und
  `UNIQUE (Abstimmung, Nummer)`. Offen: Mehrere SIM-Karten ergeben mehrere Stimmen. Es ist eine Stimme pro Nummer,
  nicht pro Person. Außerdem fehlt ein Gesamtbudget für SMS, da ein Browser bis zum Limit SMS auslösen kann.
- **SMS-Kosten und Belästigung:** Höchstens drei Codes pro Nummer und Stunde, nur Mobilnummern, und vor dem Versand
  wird die Datenbank gefragt. Offen: Mit einer fremden Nummer kann man diese Person trotzdem dreimal pro Stunde anschreiben.
- **Code erraten:** 6 Ziffern, 10 Minuten, 5 Versuche, gebunden an Abstimmung und Browser.
- **Datenbank gestohlen:** Nummern und Codes liegen nur als HMAC mit dem Server-Schlüssel vor, nie im Klartext.
- **Über die Seite:** nur JSON (gegen CSRF), nur `textContent` und eine strenge CSP (gegen XSS), kein Admin-Zugang über das Netz.

Um diese Schichten zu testen, gebe ich Claude oft Anweisungen, sich in die Rolle eines Angreifers zu versetzen oder bewusst den Code mit Fehlern zu belasten, um zu schauen, ob die Tests diese auffangen würden. Dabei entdeckt er Dinge wie diese:
### Als Angreifer: technische Lücken

1. Ein Browser kann SMS an beliebig viele Nummern auslösen. Das habe ich bestätigt: Mit demselben Cookie habe ich sechs verschiedene Nummern geschickt, jede bekam 202 und eine SMS.
- Das Limit von 3 Codes gilt pro Nummer, nicht pro Browser. Jede neue Anfrage ersetzt einfach die vorläufige Stimme.
- Bremsen tut nur das allgemeine Limit von 30 Anfragen pro Minute und IP. Das sind über 40.000 SMS pro Tag von einer einzigen IP.
- Bei ein paar Cent pro SMS kostet das den Betreiber grob tausend Euro oder mehr am Tag. Gleichzeitig bekommen Zehntausende Fremde ungewollte SMS.
- Ein Gesamtbudget für SMS gibt es nicht.
- Damit ist der Punkt "SMS-Kosten" in deinem gekürzten Abschnitt 3 zu optimistisch formuliert. *(Claude bezieht sich hier auf meinen ersten Entwurf dieses Abschnitts.)*

2. IPv6 hebelt die Limits pro IP aus. Das habe ich nur im Code gelesen, nicht getestet.
- Gezählt wird pro vollständiger Adresse.
- Ein normaler Anschluss bekommt mit IPv6 oft einen ganzen Adressblock, also praktisch unbegrenzt viele Adressen.
- Damit laufen "30 pro Minute" und "20 neue Wähler pro Stunde" für so einen Angreifer ins Leere. Zusammen mit Lücke 1 ist der SMS-Versand dann gar nicht mehr begrenzt.
- Richtig wäre, IPv6 pro Block zu zählen (/64).

3. Fehler beim Betrieb ausnutzen. Beides steht schon im README:
- Läuft der Server produktiv ohne NODE_ENV=production, kann der Demo-Modus aktiv bleiben. Dann steht der Code auf der Seite, und die SMS-Prüfung ist wertlos.
- TRUST_PROXY=1 ohne echten Proxy erlaubt es, die eigene IP zu fälschen.
- Ein Angreifer sucht genau nach solchen Konfigurationsfehlern.

### Gefahr durch Missbraucher
Das sind Leute, die sich an alle technischen Regeln halten:
- Gekaufte Nummern. Es gibt Online-Dienste, die deutsche Mobilnummern zum Empfang einer SMS für Cent-Beträge vermieten. Hunderte Stimmen kosten so ein paar Euro, und jede ist für unser System eine echte, bestätigte Stimme.
- Mobilisierung über die Grenze hinaus. "Jedes Mitglied bringt die Handys von zehn Verwandten." Technisch ist das nicht zu unterscheiden.
- Sabotage mit der eigenen Schutzregel. Wer kurz vor Schluss die Nummern der Mitglieder eines Konkurrenzvereins je dreimal eingibt, sperrt deren Codes für eine Stunde. Die Schutzmaßnahme wird zur Waffe.
- Ausspähen. Die Antwort 409 verrät, ob eine bestimmte Nummer abgestimmt hat. Ein Chef oder ein rivalisierender Verein kann das prüfen.

Diese Gefahren sind in dieser Demonstration bewusst offengelassen.
