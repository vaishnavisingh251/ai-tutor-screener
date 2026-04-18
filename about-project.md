# Project: AI Tutor Screener

## What I am building
An AI interviewer web app for Cuemath that conducts a short voice interview 
with tutor candidates and gives a structured evaluation report.

## Tech Stack
- Frontend: HTML, CSS, JavaScript (no frameworks)
- Backend: Node.js + Express
- AI: Gemini API (free)
- Voice: Browser Web Speech API

## Who I am
- Final year B.Tech IT student at PSIT, Kanpur
- Some experience with HTML, CSS, JavaScript
- Completed frontend internship at BrainWave Matrix Solutions
- Projects: SafeDropIndia, CodeSage, WaveMeet

## How the app works
1. Candidate enters their name → clicks Start Interview
2. AI speaks welcome message (text-to-speech)
3. AI asks 4 questions one by one
4. Candidate clicks mic button and speaks answers
5. Answers sent to Gemini API for evaluation
6. Results page shows scores out of 10 for:
   - Communication Clarity
   - Warmth
   - Simplicity
   - Patience
   - English Fluency
   - Overall Decision: Move to Next Round / Not Recommended

## Important Rules
- Gemini API key must NEVER be in frontend code
- Always keep API key in backend (server.js)
- Design should look professional and welcoming
- No robotic feeling — warm and friendly tone