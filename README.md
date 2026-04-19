# Cuemath Tutor Screener (AI Voice Interview)

This project is a warm, natural voice interview app that interviews tutor candidates and produces a structured evaluation report using the Gemini API.

## Features

- Welcome screen with Cuemath branding + start button
- Voice interview (SpeechRecognition + SpeechSynthesis)
- Adaptive follow-up logic via `POST /check-answer`
- Evaluation report via `POST /evaluate` using Gemini
- Animated results UI (dimension bars + donut chart)
- Print / “Download as PDF” via browser print dialog

## Setup

1. Install Node.js (v18+ recommended)
2. Open this folder in a terminal (the project root, e.g. `ai-tutor-screener`).
3. Install dependencies:
   - `npm install`
4. Add your Gemini key:
   - Edit `.env` and set `GEMINI_API_KEY=YOUR_KEY_HERE`
5. Start the server:
   - `npm run dev`
   - or `npm start`

## Run

Open:
- `http://localhost:3000`

## Notes (Voice APIs)

- This uses browser speech APIs and works best in Chrome.
- Some browsers require HTTPS for microphone permissions. On local development, Chrome usually works with `localhost`.

## API Endpoints

- `POST /check-answer`
  - Body: `{ question, answer }`
  - Response: `{ isVague: boolean, followUpQuestion: string }`

- `POST /evaluate`
  - Body: `{ name, email, responses, timestamp }`
  - Response: evaluation JSON (dimensions + overall score/decision)

