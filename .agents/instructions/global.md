# PROJECT OVERVIEW

Project Name:
MBG - AI Assistive Vision System for Visually Impaired Users

Core Goal:
Develop a mobile assistive application that helps visually impaired users understand surrounding environments using AI-generated image descriptions and voice interaction.

Architecture:
Hybrid Client-Server Architecture

Frontend:
React Native + Expo

Backend:
ElysiaJS + Bun

AI Inference:
LM Studio Local API + Gemma Model

---

# SYSTEM ARCHITECTURE

[React Native Mobile App]
- Voice command listener
- Speech-to-Text
- Camera capture
- Image compression
- Send image to backend
- Receive AI response
- Text To Speech output

        ↓ HTTP REST API

[ElysiaJS Backend]
- Receive image
- Validate request
- Analyze user command
- Inject assistive prompt
- Forward request to LM Studio API
- Format AI response

        ↓ HTTP

[LM Studio Local Server]
- Gemma model inference
- Vision-language processing

---

# MAIN OBJECTIVE

The system MUST focus on:
- Accessibility
- Lightweight communication
- Fast response
- Hands-free interaction
- Stability

The system is NOT intended for:
- Real-time streaming
- Multi-user scaling
- Cloud deployment
- Enterprise infrastructure

---

# PRIMARY USE CASE

Target users:
Visually impaired users

Main functionality:
- User speaks command
- System captures environment image automatically
- AI generates contextual description
- System provides spoken feedback

Examples:
- "Ada kursi di depan Anda."
- "Terdapat tangga di sebelah kiri."
- "Jalur di depan cukup aman untuk berjalan."

---

# INTERACTION FLOW

The application uses voice-triggered interaction.

Users interact with the system using Indonesian voice commands.

Example commands:
- "MBG, apa yang ada di depan saya?"
- "MBG, apakah ada bahaya di depan?"
- "MBG, apakah jalan di depan aman?"
- "MBG, ada siapa di sekitar saya?"

System flow:
1. User speaks command
2. Speech-to-Text converts speech into text
3. System validates trigger keyword ("MBG")
4. Camera captures image automatically
5. Image is compressed
6. Image is sent to backend
7. Backend forwards request to LM Studio
8. AI generates contextual response
9. Response is spoken using TTS

---

# VOICE COMMAND RULES

Primary interaction method:
Voice commands + TTS feedback

Trigger keyword:
"MBG"

Examples of valid commands:
- "MBG, apa yang ada di depan saya?"
- "MBG, apakah ada orang di sekitar?"
- "MBG, apakah jalan di depan aman?"
- "MBG, jelaskan area ini."
- "MBG, apakah ada benda berbahaya?"

If trigger keyword is not detected:
- Ignore command
- Do not capture image

The app should minimize manual interaction.

---

# DEVELOPMENT PRIORITIES

Priority Order:
1. Backend stability
2. AI inference working
3. Voice interaction
4. API communication
5. Mobile integration
6. Accessibility features
7. UI improvements

DO NOT prioritize:
- Fancy UI
- Animations
- Complex architecture
- Realtime features

---

# ENGINEERING PRINCIPLES

Always prefer:
- Simplicity
- Stability
- Lightweight implementation
- Minimal dependencies
- Readable code
- Fast debugging

Avoid:
- Overengineering
- Unnecessary abstractions
- Premature optimization
- Complex state management
- Realtime socket systems

---

# FRONTEND RULES

Framework:
React Native + Expo

Allowed libraries:
- expo-camera
- expo-speech
- expo-image-manipulator
- axios
- react-native-voice

Frontend responsibilities:
- Listen to voice commands
- Detect trigger keyword
- Capture image
- Compress image
- Send API request
- Render text response
- Speak response using TTS

Frontend MUST NOT:
- Perform AI inference
- Handle model logic
- Handle prompt engineering

Avoid:
- Heavy UI frameworks
- Native module customization
- Unnecessary animations

---

# BACKEND RULES

Framework:
ElysiaJS

Runtime:
Bun

Responsibilities:
- Receive image
- Validate request
- Analyze user voice command
- Inject prompts
- Communicate with LM Studio API
- Return structured response

Backend MUST:
- Keep APIs simple
- Return JSON responses
- Handle errors safely
- Use lightweight processing

Avoid:
- Complex authentication
- Database-heavy systems
- WebSocket implementation
- Microservices

---

# AI INFERENCE RULES

Inference Server:
LM Studio

Model:
gemma-4-E4B-it

Inference should:
- Focus on accessibility context
- Prioritize obstacle awareness
- Prioritize dangerous object detection
- Focus on nearby environment understanding

Avoid generic prompts like:
"Describe this image."

Prefer prompts like:
"Describe obstacles, dangerous objects, nearby people, and safe walking directions for visually impaired users."

---

# CONTEXT-AWARE PROMPTING

Backend should dynamically adapt prompts based on user commands.

Example:

User command:
"MBG, apa yang ada di depan saya?"

Generated prompt:
"Describe what is directly in front of the visually impaired user. Focus on obstacles and walking direction."

---

User command:
"MBG, apakah ada bahaya di depan?"

Generated prompt:
"Identify dangerous objects or obstacles in front of the visually impaired user."

---

User command:
"MBG, apakah jalan di depan aman?"

Generated prompt:
"Analyze whether the walking path ahead is safe and unobstructed."

---

# IMAGE PROCESSING RULES

Before sending image:
- Compress image
- Resize image
- Keep payload lightweight

Recommended image size:
224x224
or
384x384

Avoid:
- Large images
- Raw high-resolution uploads
- Continuous image streaming

---

# RESPONSE RULES

Response MUST:
- Be concise
- Be contextual
- Be understandable
- Focus on safety

Bad Example:
"Terdapat dapur modern dengan pencahayaan estetik."

Good Example:
"Terdapat kursi di depan dan jalur kanan lebih aman."

---

# ACCESSIBILITY RULES

Accessibility is CORE FEATURE.

The app should:
- Minimize visual complexity
- Support spoken interaction
- Provide fast feedback
- Avoid overwhelming information
- Support hands-free interaction

TTS responses should:
- Be short
- Be actionable
- Be clear

---

# API RULES

Main endpoint:
POST /describe

Communication:
multipart/form-data

Response format:
{
  "success": true,
  "description": "Terdapat kursi di depan Anda."
}

---

# PERFORMANCE TARGETS

Optimize:
- Image size
- Prompt size
- Inference pipeline

Avoid:
- Multiple inference calls
- Concurrent heavy processing

---

# ERROR HANDLING

Always handle:
- Camera failure
- Network failure
- LM Studio unavailable
- Invalid image
- Timeout response
- Speech recognition failure

Return user-friendly messages.

---

# CODE STYLE

Code must:
- Be modular
- Be readable
- Use consistent naming
- Avoid unnecessary complexity

Prefer:
- Small functions
- Clear variable names
- Explicit logic

Avoid:
- Giant files
- Magic values
- Overly abstract architecture

---

# PROJECT PHILOSOPHY

The project goal is:
Building a useful assistive system for visually impaired users.

The goal is NOT:
Creating the most complex AI architecture possible.

A stable working system is more important than experimental engineering complexity.