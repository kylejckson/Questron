# Questron

**[questron.app](https://questron.app)** — Free, real-time multiplayer quiz platform. No account, no install.

Host live quiz games for classrooms, remote teams, or trivia nights. Players join with a 6-character room code on any device.

## Features

- **Real-time multiplayer** — WebSocket-powered, sub-second latency
- **Streak system** — consecutive correct answers earn bonus points
- **Race leaderboard** — live speed-based rankings after every question
- **3D card-flip reveals** — animated answer reveals with sound effects
- **QR code lobby** — players scan to join instantly
- **Quiz Builder** — create `.questron` quiz packs with image support
- **Quiz Library** — browse and play community quizzes
- **Mobile-first** — responsive design, works on phones, tablets, and desktops
- **Dark PULSE UI** — animated particle background, lime-accent design system
- **Secure** — host secret auth, origin validation, rate limiting, CSPRNG room codes

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS on Cloudflare Pages |
| Game Server | Cloudflare Workers + Durable Objects (TypeScript) |
| Transport | Native WebSockets |
| CDN Assets | jsDelivr (JSZip), cdnjs (QRCode.js) |

## Quick Start (Local Dev)

```bash
git clone https://github.com/kylejckson/Questron.git
cd Questron
npm install
cd worker && npm install && cd ..

# Run both frontend and worker
npm run dev
```

- Frontend: `http://localhost:3000`
- Worker: `http://localhost:8787`

## Project Structure

```
public/          Static frontend (served by Cloudflare Pages)
  index.html     Landing page
  host.html      Host/create game screen
  join.html      Room code entry
  player.html    Player game screen
  builder.html   Quiz builder tool
  library.html   Browse community quizzes
  constants.js   Shared config (server URL, helpers)
  host.js        Host game logic
  player.js      Player game logic
  styles.css     PULSE design system
worker/          Cloudflare Worker (game server)
  src/index.ts   Request router
  src/GameRoom.ts Durable Object — game state machine
scripts/         CLI tools
  pack-quiz.js   Pack quiz folders into .questron files
```

## Creating Quizzes

Use the [Builder](https://questron.app/build) to create quiz packs in-browser, or run the CLI packer:

```bash
npm run pack:quiz -- path/to/quiz-folder
```

Quiz format: JSON with questions, 4 answer choices, correct index, and optional images.

## License

MIT — see [LICENSE](LICENSE).

Built by [Kyle Jackson](https://github.com/kylejckson).
