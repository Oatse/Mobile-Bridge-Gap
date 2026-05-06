# FRONTEND DEVELOPMENT GUIDE

Framework:
React Native + Expo

Main Features:
- Voice command listener
- Speech-to-Text
- Camera capture
- Image compression
- API request
- Display response
- Text-to-Speech

---

# REQUIRED LIBRARIES

- expo-camera
- expo-speech
- expo-image-manipulator
- axios
- react-native-voice

---

# FRONTEND FLOW

1. User speaks command
2. Detect trigger keyword ("MBG")
3. Convert speech into text
4. Capture image automatically
5. Compress image
6. Send image + command to backend
7. Receive response
8. Speak result using TTS

---

# VOICE INTERACTION

Primary interaction:
Voice-first interaction

Examples:
- "MBG, apa yang ada di depan saya?"
- "MBG, apakah jalan di depan aman?"
- "MBG, apakah ada orang di sekitar saya?"

If trigger keyword is not detected:
- Ignore command
- Do not trigger camera

---

# UI PRINCIPLES

UI must:
- Be minimal
- Use large buttons
- Use simple layouts
- Avoid clutter

Avoid:
- Fancy transitions
- Complex navigation
- Heavy animations

---

# NETWORK RULES

Backend URL should be configurable.

Use:
Environment variables or constants.

Avoid:
Hardcoded localhost values inside components.

---

# STATE MANAGEMENT

Prefer:
- useState
- useEffect

Avoid:
- Redux
- Overengineered global state

---

# PERFORMANCE RULES

Always:
- Compress images before upload
- Avoid unnecessary re-renders

Avoid:
- Continuous camera processing
- Background loops

---

# ACCESSIBILITY

Accessibility is mandatory.

Implement:
- Spoken feedback
- Large touch targets
- Minimal text dependency
- Hands-free interaction