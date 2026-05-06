# BACKEND DEVELOPMENT GUIDE

Framework:
ElysiaJS

Runtime:
Bun

Purpose:
Act as lightweight middleware between mobile app and LM Studio.

---

# RESPONSIBILITIES

Backend handles:
- Image upload
- Validation
- User command analysis
- Prompt injection
- LM Studio communication
- Response formatting

Backend DOES NOT:
- Run AI model directly
- Store large data
- Handle realtime streaming

---

# API STRUCTURE

POST /describe

Input:
multipart/form-data

Fields:
- image
- userCommand

Output:
{
  "success": true,
  "description": "Terdapat kursi di depan Anda."
}

---

# LM STUDIO COMMUNICATION

LM Studio acts as OpenAI-compatible API server.

Backend should:
- Send image + prompt
- Parse model response
- Handle timeout safely

---

# PROMPT RULES

Always use assistive-focused prompts.

Focus on:
- Obstacles
- Dangerous objects
- Walking direction
- Nearby humans
- Environmental awareness

Avoid:
- Artistic descriptions
- Unnecessary details

---

# CONTEXT-AWARE PROMPTING

Backend must dynamically adapt prompts based on user command intent.

Example:

User:
"MBG, apa yang ada di depan saya?"

Prompt:
"Describe what is directly in front of the visually impaired user. Focus on nearby obstacles and safe walking direction."

---

User:
"MBG, apakah ada bahaya di depan?"

Prompt:
"Identify dangerous objects or obstacles in front of the visually impaired user."

---

User:
"MBG, apakah jalan di depan aman?"

Prompt:
"Analyze whether the walking path ahead is safe and unobstructed."

---

# ERROR HANDLING

Handle:
- Invalid image
- LM Studio offline
- Timeout
- Empty response
- Invalid user command

Return safe fallback responses.

---

# PERFORMANCE RULES

Optimize:
- Small payloads
- Fast response time
- Lightweight middleware

Avoid:
- Heavy image processing
- Large memory usage
- Blocking operations

---

# CODE STYLE

Prefer:
- Modular routes
- Small services
- Clear naming

Avoid:
- Monolithic files
- Deep abstraction