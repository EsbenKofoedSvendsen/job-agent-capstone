# Job concierge (Google ADK + Gemini)

A conversational front-end for the Job Agent, built with the
[Agent Development Kit](https://google.github.io/adk-docs/). Gemini answers
questions like "what are my best matches today?", "score this posting", or
"which sources are broken?" by calling the live system's API as tools.

```bash
cd adk-agent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export GOOGLE_API_KEY=...          # aistudio.google.com -> Get API key
export GOOGLE_GENAI_USE_VERTEXAI=FALSE
export JOB_AGENT_URL=https://your-app.fly.dev
export JOB_AGENT_PASSWORD=...      # the app's APP_PASSWORD

adk run job_concierge     # terminal chat
adk web                   # or the ADK dev UI in a browser
```
