(() => {
  const API_BASE = ''; // same-origin (server exposes /check-answer and /evaluate)
  const QUESTION_TIME_LIMIT_SECONDS = 60
  const MIN_DYNAMIC_FOLLOWUPS = 0
  const MAX_DYNAMIC_FOLLOWUPS = 3

  // Interview core questions.
  const CORE_QUESTIONS = [
    'To start, could you tell me a little about yourself and what draws you to teaching?',
    'Imagine you are teaching a 9-year-old. Can you explain what a fraction is — as if I am that child right now?',
    'A student has been staring at the same problem for 5 minutes. They look frustrated and say they just don\'t get it. Walk me through exactly what you would do.',
    'How do you keep a child engaged and excited about learning when they are clearly losing interest or getting distracted?',
    'Tell me about a time you explained something difficult in a simple way — to anyone, not just students.'
  ];

  // Used only when the last answer looks substantive (not evasive / not a one-liner).
  const SUBSTANTIVE_POSITIVE_ACKS = [
    'Thank you — that gives a clear picture. Let\'s go to the next question.',
    'I appreciate the detail there. Here is the next question.',
    'That helps me understand your approach. Moving on.'
  ];

  const NEUTRAL_TRANSITION_ACKS = [
    'Alright — here is the next question.',
    'Let\'s continue with the next question.',
    'Thank you. Here is the next part of the interview.'
  ];

  const HONEST_WEAK_TRANSITION_ACKS = [
    'Okay — let\'s move on to the next question.',
    'Understood. Here is the next question.',
    'Let\'s go to the next question.'
  ];

  const FOLLOW_UP_CLOSING_ACKS = [
    'Thanks for adding that. Here is the next question.',
    'Alright — let\'s continue.',
    'Let\'s move to the next part of the interview.'
  ];

  const MIN_FOLLOWUP_FALLBACKS = [
    'Can you give one real example and your exact steps?',
    'Pick one student moment and tell me what you would say first, then next.',
    'Please make it concrete with one case and a simple step-by-step answer.',
    'What is the very first thing you would say out loud to the student?',
    'Break it into two clear steps — step one, then step two.',
    'Name one real situation and what you would do differently from a textbook answer.'
  ];

  const ATTEMPT_LOCK_PREFIX = 'cuemath_interview_attempt_v1:'

  const elements = {
    // Welcome
    screenWelcome: document.getElementById('screen-welcome'),
    screenPolicy: document.getElementById('screen-policy'),
    startBtn: document.getElementById('start-btn'),
    policyOkBtn: document.getElementById('policy-ok-btn'),
    fullName: document.getElementById('full-name'),
    email: document.getElementById('email'),
    welcomeError: document.getElementById('welcome-error'),

    // Interview
    screenInterview: document.getElementById('screen-interview'),
    progressFill: document.getElementById('progress-fill'),
    progressPercent: document.getElementById('progress-percent'),
    questionTimeRemaining: document.getElementById('question-time-remaining'),
    stepIndicators: document.getElementById('step-indicators'),

    questionText: document.getElementById('question-text'),
    questionBadge: document.getElementById('question-badge'),
    transcript: document.getElementById('transcript'),
    waveform: document.getElementById('waveform'),
    recordInstruction: document.getElementById('record-instruction'),
    countdownRing: document.getElementById('countdown-ring'),
    countdownSeconds: document.getElementById('countdown-seconds'),
    countdownWarning: document.getElementById('countdown-warning'),
    micHelperText: document.getElementById('mic-helper-text'),

    micBtn: document.getElementById('mic-btn'),
    reRecordBtn: document.getElementById('re-record-btn'),
    submitAnswerBtn: document.getElementById('submit-answer-btn'),
    interviewError: document.getElementById('interview-error'),

    processingOverlay: document.getElementById('processing-overlay'),
    processingText: document.getElementById('processing-text'),

    // Results
    screenResults: document.getElementById('screen-results'),
    resultsLoading: document.getElementById('results-loading'),
    resultsContent: document.getElementById('results-content'),
    resultsError: document.getElementById('results-error'),
    loadingMessage: document.getElementById('loading-message'),

    rName: document.getElementById('r-name'),
    rEmail: document.getElementById('r-email'),
    rDate: document.getElementById('r-date'),
    rTime: document.getElementById('r-time'),

    dimensionList: document.getElementById('dimension-list'),
    overallSummary: document.getElementById('overall-summary'),
    keyStrengths: document.getElementById('key-strengths'),
    areasForImprovement: document.getElementById('areas-for-improvement'),

    donutFg: document.getElementById('donut-fg'),
    donutText: document.getElementById('donut-text'),
    decisionBadge: document.getElementById('overall-decision-badge'),

    printBtn: document.getElementById('print-btn'),
    newInterviewBtn: document.getElementById('new-interview-btn')
  }

  const state = {
    phase: 'welcome', // welcome | intro | interview | results
    stepKey: 'intro', // intro | q1..q5 | results

    candidate: {
      name: '',
      email: ''
    },

    interviewStartedAt: null,

    coreIndex: 0, // 0..4
    awaitingFollowUp: false,
    followUpCountForCurrent: 0,
    currentAskedQuestion: '',
    currentCoreQuestion: '',
    currentRecord: null, // object to store answers

    lastWarmAck: null,
    lastClosingAck: null,

    lastCheck: null,

    recognition: null,
    recording: false,
    suppressOnEnd: false,
    recordingStartedAt: null,
    recordingTickerId: null,
    questionTimerEndAt: null,
    questionTimerTickId: null,
    autoSubmitTimerId: null,
    timerAutoSubmitting: false,
    timerRunning: false,
    ignoreResultsUntilMs: 0,
    permissionPromptGuardUntilMs: 0,
    disqualified: false,
    disqualifyReason: '',
    committedTranscript: '',
    interimTranscript: '',
    finalTranscript: ''
  }

  const STEP_KEYS = ['intro', 'q1', 'q2', 'q3', 'q4', 'q5', 'results']

  function setScreen(screen) {
    elements.screenWelcome.classList.toggle('is-active', screen === 'welcome')
    elements.screenPolicy.classList.toggle('is-active', screen === 'policy')
    elements.screenInterview.classList.toggle('is-active', screen === 'interview')
    elements.screenResults.classList.toggle('is-active', screen === 'results')
  }

  function setStep(stepKey) {
    state.stepKey = stepKey
    const stepEls = elements.stepIndicators?.querySelectorAll('.step-indicator') || []
    stepEls.forEach((el) => {
      const k = el.getAttribute('data-step')
      el.classList.remove('active')
      el.classList.remove('done')
      if (k === stepKey) el.classList.add('active')
    })

    // Mark all steps before current as done.
    const currentIdx = STEP_KEYS.indexOf(stepKey)
    stepEls.forEach((el) => {
      const k = el.getAttribute('data-step')
      const idx = STEP_KEYS.indexOf(k)
      if (idx !== -1 && idx < currentIdx) el.classList.add('done')
    })

    // Progress percentage.
    const totalSteps = STEP_KEYS.length - 1
    const pct = Math.max(0, Math.min(100, Math.round((currentIdx / totalSteps) * 100)))
    elements.progressPercent.textContent = `${pct}%`
    elements.progressFill.style.width = `${pct}%`
  }

  function formatDateTime(iso) {
    const d = new Date(iso)
    const date = d.toLocaleDateString()
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return { date, time }
  }

  function setError(el, message) {
    el.textContent = message || ''
  }

  function emailKey(email) {
    return String(email || '').trim().toLowerCase()
  }

  function lockKeyForEmail(email) {
    return `${ATTEMPT_LOCK_PREFIX}${emailKey(email)}`
  }

  function readAttemptLock(email) {
    const key = lockKeyForEmail(email)
    if (!key) return null
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  function markAttemptLock(email, status, meta = {}) {
    const key = lockKeyForEmail(email)
    if (!key) return
    const payload = {
      email: emailKey(email),
      status: String(status || 'started'),
      lockedAt: new Date().toISOString(),
      ...meta
    }
    try {
      localStorage.setItem(key, JSON.stringify(payload))
    } catch {}
  }

  function getAttemptLockMessage(lockData) {
    const status = String(lockData?.status || '')
    if (status === 'disqualified') {
      return 'This email already attempted the interview and was disqualified for leaving the interview screen.'
    }
    if (status === 'completed') {
      return 'This email has already completed the interview. Multiple attempts are not allowed.'
    }
    return 'This email has already started the interview. Multiple attempts are not allowed.'
  }

  function isWelcomeFormValid() {
    const name = String(elements.fullName?.value || '').trim()
    const email = String(elements.email?.value || '').trim()
    return Boolean(name) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  }

  function syncStartButtonState() {
    if (!elements.startBtn) return
    elements.startBtn.disabled = !isWelcomeFormValid()
  }

  function showProcessingOverlay(message) {
    elements.processingText.textContent = message || 'Processing...'
    elements.processingOverlay.classList.remove('is-hidden')
  }

  function hideProcessingOverlay() {
    elements.processingOverlay.classList.add('is-hidden')
  }

  function endInterviewAsRejected(reasonText) {
    if (state.disqualified || state.phase !== 'interview') return

    state.disqualified = true
    state.disqualifyReason = String(reasonText || 'Interview policy violation detected.').trim()
    markAttemptLock(state.candidate?.email, 'disqualified', {
      reason: state.disqualifyReason
    })
    state.phase = 'results'

    clearQuestionTimerRuntime()
    state.timerAutoSubmitting = false
    state.suppressOnEnd = true
    state.recording = false
    stopWaveform()
    stopRecording()
    stopSpeaking()
    hideProcessingOverlay()

    setScreen('results')
    setStep('results')

    const nowIso = new Date().toISOString()
    const dt = formatDateTime(nowIso)
    elements.rName.textContent = state.candidate.name || '-'
    elements.rEmail.textContent = state.candidate.email || '-'
    elements.rDate.textContent = dt.date
    elements.rTime.textContent = dt.time

    elements.resultsError.textContent = ''
    elements.resultsLoading.classList.add('is-hidden')
    elements.resultsContent.classList.remove('is-hidden')
    elements.dimensionList.innerHTML = ''
    elements.keyStrengths.innerHTML = ''
    elements.areasForImprovement.innerHTML = ''

    setDonut(0)
    setDecisionBadge('Not Recommended')
    if (elements.overallSummary) {
      const msg =
        `Interview auto-submitted and rejected. Reason: ${state.disqualifyReason} ` +
        'Please stay on the interview screen for the full session.'
      elements.overallSummary.textContent = msg
      elements.overallSummary.classList.remove('is-hidden')
      elements.overallSummary.setAttribute('aria-hidden', 'false')
    }

    const li = document.createElement('li')
    li.textContent = 'Complete the interview in one continuous focused session.'
    elements.areasForImprovement.appendChild(li)
  }

  function setInterviewControlsEnabled({ micEnabled, reRecordEnabled, submitEnabled }) {
    elements.micBtn.disabled = !micEnabled
    elements.reRecordBtn.disabled = !reRecordEnabled
    elements.submitAnswerBtn.disabled = !submitEnabled
    if (elements.transcript) {
      // Voice-first UX: transcript is display-only.
      elements.transcript.readOnly = true
    }
  }

  function formatClock(totalSeconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds || 0)))
    const mm = Math.floor(safeSeconds / 60)
    const ss = safeSeconds % 60
    return `${mm}:${String(ss).padStart(2, '0')}`
  }

  function formatElapsed(ms) {
    const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000))
    return formatClock(totalSeconds)
  }

  function setTimerTone(secondsRemaining) {
    const ring = elements.countdownRing
    if (!ring) return

    ring.classList.remove('tone-green', 'tone-orange', 'tone-red')
    if (secondsRemaining <= 14) ring.classList.add('tone-red')
    else if (secondsRemaining <= 29) ring.classList.add('tone-orange')
    else ring.classList.add('tone-green')
  }

  function updateQuestionTimeDisplay(secondsRemaining, fraction = null) {
    const safeSeconds = Math.max(0, Math.ceil(Number(secondsRemaining || 0)))
    const safeFraction = Number.isFinite(fraction)
      ? Math.max(0, Math.min(1, fraction))
      : safeSeconds / QUESTION_TIME_LIMIT_SECONDS

    if (elements.countdownSeconds) {
      elements.countdownSeconds.textContent = `${String(safeSeconds)}s`
    }
    if (elements.questionTimeRemaining) {
      elements.questionTimeRemaining.textContent = `Time left: ${formatClock(safeSeconds)}`
    }
    if (elements.micHelperText) {
      elements.micHelperText.textContent = ''
    }

    setTimerTone(safeSeconds)

    if (elements.countdownRing) {
      elements.countdownRing.style.width = `${safeFraction * 100}%`
    }

    if (elements.countdownWarning) {
      if (safeSeconds <= 0) {
        elements.countdownWarning.textContent = 'Time is up! Moving to next question...'
      } else if (safeSeconds <= 10) {
        elements.countdownWarning.textContent = 'Wrapping up soon...'
      } else {
        elements.countdownWarning.textContent = ''
      }
    }
  }

  function clearQuestionTimerRuntime() {
    if (state.questionTimerTickId) {
      clearInterval(state.questionTimerTickId)
      state.questionTimerTickId = null
    }
    if (state.autoSubmitTimerId) {
      clearTimeout(state.autoSubmitTimerId)
      state.autoSubmitTimerId = null
    }
    state.questionTimerEndAt = null
    state.timerRunning = false
  }

  function resetQuestionTimer() {
    clearQuestionTimerRuntime()
    state.timerAutoSubmitting = false
    updateQuestionTimeDisplay(QUESTION_TIME_LIMIT_SECONDS, 1)
  }

  async function handleQuestionTimeExpired() {
    if (state.timerAutoSubmitting) return

    state.timerAutoSubmitting = true
    clearQuestionTimerRuntime()
    updateQuestionTimeDisplay(0, 0)

    if (state.recording) {
      state.suppressOnEnd = true
      setRecordingUi(false)
      stopRecording()
    }

    setInterviewControlsEnabled({
      micEnabled: false,
      reRecordEnabled: false,
      submitEnabled: true
    })

    state.autoSubmitTimerId = setTimeout(() => {
      state.autoSubmitTimerId = null
      submitCurrentAnswer({
        allowEmpty: true,
        fallbackText: 'No verbal response provided within the time limit.'
      })
    }, 2000)
  }

  function startQuestionTimer() {
    clearQuestionTimerRuntime()
    state.timerAutoSubmitting = false
    state.questionTimerEndAt = Date.now() + QUESTION_TIME_LIMIT_SECONDS * 1000
    state.timerRunning = true
    updateQuestionTimeDisplay(QUESTION_TIME_LIMIT_SECONDS, 1)

    state.questionTimerTickId = setInterval(() => {
      if (!state.timerRunning || !state.questionTimerEndAt) return

      const msLeft = Math.max(0, state.questionTimerEndAt - Date.now())
      const secLeft = msLeft / 1000
      updateQuestionTimeDisplay(secLeft, secLeft / QUESTION_TIME_LIMIT_SECONDS)

      if (msLeft <= 0) {
        handleQuestionTimeExpired()
      }
    }, 100)
  }

  function updateRecordingIndicator() {
    if (!state.recording || !state.recordingStartedAt) {
      elements.recordInstruction.textContent = 'Click mic to answer'
      return
    }
    elements.recordInstruction.textContent = ''
  }

  function hasTranscriptText() {
    return Boolean(String(elements.transcript?.value || '').trim())
  }

  function syncAnswerActionButtons() {
    // Keep submit available whenever we have text, even if recognition end event is delayed.
    const hasText = hasTranscriptText()
    if (state.recording) {
      setInterviewControlsEnabled({
        micEnabled: true,
        reRecordEnabled: true,
        submitEnabled: hasText
      })
      return
    }

    setInterviewControlsEnabled({
      micEnabled: true,
      reRecordEnabled: hasText,
      submitEnabled: hasText
    })
  }

  function canUseSpeechRecognition() {
    return typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)
  }

  function getSpeechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition
  }

  async function ensureSpeechVoices() {
    if (!('speechSynthesis' in window)) return []

    const voices = window.speechSynthesis.getVoices()
    if (voices && voices.length > 0) return voices

    await new Promise((resolve) => {
      const t = setTimeout(resolve, 1200)
      window.speechSynthesis.onvoiceschanged = () => {
        clearTimeout(t)
        resolve()
      }
    })

    return window.speechSynthesis.getVoices() || []
  }

  async function speakText(text) {
    const safeText = String(text || '').trim()
    if (!safeText) return

    if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) return

    stopSpeaking()

    await ensureSpeechVoices()
    const voices = window.speechSynthesis.getVoices() || []

    const preferred =
      voices.find((v) => /female/i.test(v.name) && /en/i.test(v.lang)) ||
      voices.find((v) => /en/i.test(v.lang)) ||
      voices[0] ||
      null

    await new Promise((resolve) => {
      const utter = new SpeechSynthesisUtterance(safeText)
      utter.rate = 0.85
      utter.pitch = 1.1
      utter.volume = 1
      if (preferred) utter.voice = preferred

      utter.onend = () => resolve()
      utter.onerror = () => resolve()

      window.speechSynthesis.speak(utter)
    })
  }

  function stopSpeaking() {
    try {
      window.speechSynthesis?.cancel()
    } catch {
      // ignore
    }
  }

  function startWaveform() {
    elements.waveform.classList.add('recording')
  }

  function stopWaveform() {
    elements.waveform.classList.remove('recording')
  }

  function setRecordingUi(isRecording) {
    state.recording = isRecording

    if (isRecording) {
      if (!state.recordingStartedAt) {
        state.recordingStartedAt = Date.now()
      }
      if (!state.recordingTickerId) {
        state.recordingTickerId = setInterval(updateRecordingIndicator, 1000)
      }
      updateRecordingIndicator()
      startWaveform()
      elements.micBtn.classList.add('recording')
      elements.micBtn.setAttribute('aria-label', 'Recording in progress')
      setInterviewControlsEnabled({
        micEnabled: true,
        reRecordEnabled: true,
        submitEnabled: false
      })
      setError(elements.interviewError, '')
    } else {
      if (state.recordingTickerId) {
        clearInterval(state.recordingTickerId)
        state.recordingTickerId = null
      }
      state.recordingStartedAt = null
      elements.recordInstruction.textContent = 'Click mic to answer'
      stopWaveform()
      elements.micBtn.classList.remove('recording')
      elements.micBtn.setAttribute('aria-label', 'Start recording')
      setInterviewControlsEnabled({
        micEnabled: true,
        reRecordEnabled: true,
        submitEnabled: true
      })
    }
  }

  function resetTranscriptUi() {
    state.committedTranscript = ''
    state.interimTranscript = ''
    state.finalTranscript = ''
    elements.transcript.value = ''
    if (state.phase === 'interview') {
      syncAnswerActionButtons()
    }
  }

  function getTranscriptValue() {
    return String(elements.transcript.value || '').trim()
  }

  function initSpeechRecognition() {
    if (!canUseSpeechRecognition()) return null

    const Ctor = getSpeechRecognitionCtor()
    const recognition = new Ctor()
    recognition.lang = 'en-US'
    recognition.interimResults = true
    recognition.continuous = true

    recognition.onstart = () => {
      setRecordingUi(true)
    }

    recognition.onresult = (event) => {
      // Ignore late events that can arrive after stop/reset.
      if (!state.recording) return
      if (Date.now() < Number(state.ignoreResultsUntilMs || 0)) return
      let interim = ''
      let final = ''

      // event.results is a SpeechRecognitionResultList
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        const t = r[0]?.transcript || ''
        if (r.isFinal) final += t + ' '
        else interim += t
      }

      const finalChunk = final.trim()
      if (finalChunk) {
        state.committedTranscript = `${state.committedTranscript} ${finalChunk}`.trim()
      }
      state.finalTranscript = state.committedTranscript
      state.interimTranscript = interim.trim()

      elements.transcript.value = `${state.committedTranscript} ${state.interimTranscript}`.trim()
      syncAnswerActionButtons()
    }

    recognition.onerror = (event) => {
      console.error('SpeechRecognition error:', event)
      setRecordingUi(false)
      const code = String(event?.error || '').toLowerCase()
      let message = 'Microphone error. Please check permissions and try again.'
      if (code === 'no-speech') {
        message = 'We could not hear your voice clearly. Please speak a bit louder and try again.'
      } else if (code === 'audio-capture') {
        message = 'No microphone was detected. Please connect a mic and try again.'
      } else if (code === 'not-allowed' || code === 'service-not-allowed') {
        message = 'Microphone permission is blocked. Please allow mic access and try again.'
      } else if (code === 'network') {
        message = 'Audio connection was unstable. Please try again in a quieter network environment.'
      }
      setError(
        elements.interviewError,
        message
      )
    }

    recognition.onend = () => {
      // If recording is still active, restart immediately so pauses don't end capture.
      if (state.recording && !state.suppressOnEnd) {
        try {
          recognition.start()
        } catch (err) {
          // Some browsers throw "recognition has already started"; keep session alive.
          console.warn('Recognition restart skipped:', err)
        }
        return
      }

      state.suppressOnEnd = false // one-shot suppression
      setRecordingUi(false)
    }

    return recognition
  }

  function startRecording(options = {}) {
    const restartTimer = options.restartTimer !== false
    if (!state.recognition) return
    if (restartTimer) {
      startQuestionTimer()
    }
    try {
      state.recognition.start()
    } catch (err) {
      // Starting recognition can throw if called twice quickly; treat as no-op.
      console.warn('Recognition start failed:', err)
    }
  }

  function stopRecording() {
    if (!state.recognition) return
    try {
      state.recognition.stop()
    } catch {
      // ignore
    }
  }

  function armPermissionPromptGuard(ms = 5000) {
    const windowMs = Math.max(0, Number(ms || 0))
    state.permissionPromptGuardUntilMs = Date.now() + windowMs
  }

  function shouldIgnoreFocusLoss() {
    return Date.now() < Number(state.permissionPromptGuardUntilMs || 0)
  }

  async function apiCheckAnswer(payload) {
    const resp = await fetch(`${API_BASE}/check-answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    const data = await resp.json().catch(() => null)
    if (!resp.ok) {
      const msg = data?.error || 'Unable to check your answer.'
      throw new Error(msg)
    }
    return data
  }

  async function apiEvaluate(payload) {
    const resp = await fetch(`${API_BASE}/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const data = await resp.json().catch(() => null)
    if (!resp.ok) {
      const msg = data?.error || 'Unable to evaluate your interview.'
      throw new Error(msg)
    }
    return data
  }

  function wordCountAnswer(text) {
    const t = String(text || '').trim()
    if (!t) return 0
    return t.split(/\s+/).filter(Boolean).length
  }

  function hasRefusalLanguageClient(text) {
    const s = String(text || '').trim()
    if (!s) return true
    const lower = s.toLowerCase()
    const patterns = [
      /\b(?:i\s*)?(?:don'?t|do\s*not)\s+know\b/,
      /\bwon'?t\s+answer\b/,
      /\banswer\s*(?:it\s*)?(?:later|tomorrow)\b/,
      /\b(?:maybe|perhaps)\s+later\b/,
      /\bskip\b/,
      /\bpass(?:\s+this)?\b/,
      /\bno\s+idea\b/,
      /\bnot\s+sure\b/,
      /\bnext\s+question\b/
    ]
    return patterns.some((re) => re.test(lower))
  }

  /**
   * strong = enough detail for a fair screen; weak = evasive, refusal, or too thin.
   */
  function classifyAnswerQuality(text, check) {
    const wc = wordCountAnswer(text)
    if (!text || !wc) return 'weak'
    if (hasRefusalLanguageClient(text)) return 'weak'
    if (wc < 15) return 'weak'
    if (check?.reason === 'too_short' || check?.reason === 'refusal_or_evasive') return 'weak'
    if (check?.isVague && check?.reason !== 'clear') return 'weak'
    if (wc >= 45 && !check?.isVague) return 'strong'
    return 'ok'
  }

  function pickFromPool(pool, lastKey) {
    const filtered = pool.filter((a) => a !== state[lastKey])
    const list = filtered.length ? filtered : pool
    const choice = list[Math.floor(Math.random() * list.length)]
    state[lastKey] = choice
    return choice
  }

  /**
   * Do not praise thin or evasive answers — keeps the interview feeling like a real screen.
   */
  function pickTransitionAck(text, check, hadFollowUps) {
    const tier = classifyAnswerQuality(text, check)
    if (hadFollowUps) {
      if (tier === 'strong') return pickFromPool(FOLLOW_UP_CLOSING_ACKS, 'lastClosingAck')
      if (tier === 'ok') return pickFromPool(FOLLOW_UP_CLOSING_ACKS, 'lastClosingAck')
      return pickFromPool(HONEST_WEAK_TRANSITION_ACKS, 'lastClosingAck')
    }
    if (tier === 'strong') return pickFromPool(SUBSTANTIVE_POSITIVE_ACKS, 'lastWarmAck')
    if (tier === 'ok') return pickFromPool(NEUTRAL_TRANSITION_ACKS, 'lastWarmAck')
    return pickFromPool(HONEST_WEAK_TRANSITION_ACKS, 'lastWarmAck')
  }

  function normalizeQuestionText(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function getLastFollowUpQuestion() {
    const followups = state.currentRecord?.followups
    if (!Array.isArray(followups) || followups.length === 0) return ''
    return String(followups[followups.length - 1]?.question || '').trim()
  }

  function getAskedFollowUpQuestionsForApi() {
    const followups = state.currentRecord?.followups
    if (!Array.isArray(followups)) return []
    return followups.map((f) => String(f?.question || '').trim()).filter(Boolean)
  }

  function pickMinFollowUpQuestion() {
    const used = new Set(
      (state.currentRecord?.followups || [])
        .map((f) => normalizeQuestionText(f?.question))
        .filter(Boolean)
    )
    for (const candidate of MIN_FOLLOWUP_FALLBACKS) {
      if (!used.has(normalizeQuestionText(candidate))) return candidate
    }
    return MIN_FOLLOWUP_FALLBACKS[state.followUpCountForCurrent % MIN_FOLLOWUP_FALLBACKS.length]
  }

  function cleanFeedbackItem(text) {
    let cleaned = String(text || '').replace(/\s+/g, ' ').trim()
    if (!cleaned) return ''
    cleaned = cleaned
      .replace(/re-?evaluate with active gemini quota for a more reliable final decision\.?/gi, '')
      .replace(/ai evaluation was temporarily unavailable\.?/gi, '')
      .replace(/fallback score is estimated because[^.]*\.?/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return cleaned
  }

  function coreStepKeyByIndex(idx) {
    // idx 0..4 => q1..q5
    return `q${idx + 1}`
  }

  async function speakGreetingAndBegin() {
    state.phase = 'interview'
    elements.questionBadge.textContent = 'Interview Question'
    setStep('intro')

    const greeting =
      `Hi ${state.candidate.name}! Welcome to Cuemath. ` +
      'I am your AI interviewer today. ' +
      'This will be a relaxed conversation — there are no trick questions. ' +
      'Just be yourself. Ready to begin?'

    showProcessingOverlay('Starting the interview...')
    stopSpeaking()
    await speakText(greeting)
    if (state.phase !== 'interview') return
    hideProcessingOverlay()
  }

  async function startCoreQuestion(coreIndex) {
    state.awaitingFollowUp = false
    state.followUpCountForCurrent = 0
    state.coreIndex = coreIndex
    state.currentCoreQuestion = CORE_QUESTIONS[coreIndex]
    state.currentAskedQuestion = state.currentCoreQuestion

    state.currentRecord = {
      question: state.currentCoreQuestion,
      answer: '',
      followup_question: '',
      followup_answer: '',
      followups: []
    }

    state.lastCheck = null
    state.timerAutoSubmitting = false
    elements.interviewError.textContent = ''
    resetTranscriptUi()
    resetQuestionTimer()

    elements.questionText.textContent = state.currentCoreQuestion
    elements.questionBadge.textContent = `Question ${coreIndex + 1} of 5`

    const stepKey = coreStepKeyByIndex(coreIndex)
    setStep(stepKey)

    // Speak question, then let candidate record.
    await speakText(state.currentCoreQuestion)
    if (state.phase !== 'interview') return

    // Wait for user mic click.
    setInterviewControlsEnabled({
      micEnabled: true,
      reRecordEnabled: false,
      submitEnabled: false
    })
    elements.micBtn.disabled = false
    elements.reRecordBtn.disabled = true
    elements.submitAnswerBtn.disabled = true
    elements.recordInstruction.textContent = 'Click mic to answer'
    stopWaveform()
    elements.micBtn.classList.remove('recording')
  }

  async function startFollowUpQuestion(followUpQuestion) {
    state.awaitingFollowUp = true
    state.followUpCountForCurrent += 1
    state.currentAskedQuestion = followUpQuestion
    state.currentRecord.followups.push({
      question: followUpQuestion,
      answer: ''
    })
    if (!state.currentRecord.followup_question) {
      state.currentRecord.followup_question = followUpQuestion
    }

    elements.interviewError.textContent = ''
    elements.questionBadge.textContent = `Follow-up (Q${state.coreIndex + 1})`
    elements.questionText.textContent = followUpQuestion
    resetTranscriptUi()
    resetQuestionTimer()

    // Keep step on the same Q.
    setStep(coreStepKeyByIndex(state.coreIndex))

    await speakText(followUpQuestion)
    if (state.phase !== 'interview') return
    setInterviewControlsEnabled({
      micEnabled: true,
      reRecordEnabled: false,
      submitEnabled: false
    })
    elements.recordInstruction.textContent = 'Click mic to answer'
    stopWaveform()
    elements.micBtn.classList.remove('recording')
  }

  function getStepIndicatorForCurrent() {
    return state.awaitingFollowUp ? coreStepKeyByIndex(state.coreIndex) : coreStepKeyByIndex(state.coreIndex)
  }

  async function submitCurrentAnswer(options = {}) {
    const allowEmpty = Boolean(options.allowEmpty)
    const fallbackText = String(options.fallbackText || '').trim()
    const text = getTranscriptValue() || (allowEmpty ? fallbackText : '')
    if (!text) {
      setError(elements.interviewError, 'Please speak an answer first.')
      return
    }

    clearQuestionTimerRuntime()
    state.timerAutoSubmitting = false

    // Stop recognition immediately to keep UI stable.
    state.suppressOnEnd = true
    state.recording = false
    stopWaveform()
    elements.micBtn.classList.remove('recording')
    stopRecording()
    setInterviewControlsEnabled({
      micEnabled: false,
      reRecordEnabled: false,
      submitEnabled: false
    })

    showProcessingOverlay('Checking your answer...')

    try {
      const questionForCheck = state.currentAskedQuestion || state.currentCoreQuestion

      if (state.awaitingFollowUp) {
        const followups = state.currentRecord?.followups || []
        if (followups.length > 0) {
          followups[followups.length - 1].answer = text
        }
        if (!state.currentRecord.followup_answer) {
          state.currentRecord.followup_answer = text
        }
      } else {
        state.currentRecord.answer = text
      }

      const check = await apiCheckAnswer({
        question: questionForCheck,
        coreQuestion: state.currentCoreQuestion,
        answer: text,
        followUpCount: state.followUpCountForCurrent,
        minFollowUps: MIN_DYNAMIC_FOLLOWUPS,
        maxFollowUps: MAX_DYNAMIC_FOLLOWUPS,
        askedFollowUpQuestions: getAskedFollowUpQuestionsForApi()
      })
      state.lastCheck = check

      hideProcessingOverlay()
      const shouldAskFollowUp = Boolean(check?.shouldAskFollowUp)
      const followUpQuestion = String(check?.followUpQuestion || '').trim()

      if (state.followUpCountForCurrent < MAX_DYNAMIC_FOLLOWUPS) {
        let nextFollowUpQuestion = ''
        if (shouldAskFollowUp && followUpQuestion) {
          nextFollowUpQuestion = followUpQuestion
        } else if (state.followUpCountForCurrent < MIN_DYNAMIC_FOLLOWUPS) {
          nextFollowUpQuestion = pickMinFollowUpQuestion()
        }

        const askedNorm = new Set(
          getAskedFollowUpQuestionsForApi().map((q) => normalizeQuestionText(q)).filter(Boolean)
        )
        let normalizedNext = normalizeQuestionText(nextFollowUpQuestion)
        if (normalizedNext && askedNorm.has(normalizedNext)) {
          nextFollowUpQuestion = pickMinFollowUpQuestion()
          normalizedNext = normalizeQuestionText(nextFollowUpQuestion)
        }
        const normalizedLast = normalizeQuestionText(getLastFollowUpQuestion())
        if (
          normalizedNext &&
          normalizedNext === normalizedLast &&
          state.followUpCountForCurrent < MIN_DYNAMIC_FOLLOWUPS
        ) {
          nextFollowUpQuestion = pickMinFollowUpQuestion()
        }

        if (nextFollowUpQuestion) {
          await startFollowUpQuestion(nextFollowUpQuestion)
          if (state.phase !== 'interview') return
          return
        }
      }

      if (
        shouldAskFollowUp &&
        state.followUpCountForCurrent < MAX_DYNAMIC_FOLLOWUPS
      ) {
        await startFollowUpQuestion(pickMinFollowUpQuestion())
        if (state.phase !== 'interview') return
        return
      }

      if (!state.responses) state.responses = []
      state.responses.push(state.currentRecord)

      const nextIndex = state.coreIndex + 1
      const finishedAllCore = nextIndex >= CORE_QUESTIONS.length

      if (finishedAllCore) {
        const name = state.candidate.name || 'there'
        await speakText(
          `Thank you, ${name}. You have answered all of our questions — that completes this interview.`
        )
        if (state.phase !== 'interview') return
        await goToResults()
        return
      }

      const ack = pickTransitionAck(text, check, state.followUpCountForCurrent > 0)
      await speakText(ack)
      if (state.phase !== 'interview') return

      await startCoreQuestion(nextIndex)
      if (state.phase !== 'interview') return
    } catch (err) {
      console.error(err)
      hideProcessingOverlay()
      setError(elements.interviewError, err?.message || 'Something went wrong. Please try again.')
      // Re-enable mic so user can retry.
      setInterviewControlsEnabled({
        micEnabled: true,
        reRecordEnabled: true,
        submitEnabled: true
      })
    }
  }

  async function goToResults() {
    state.phase = 'results'
    clearQuestionTimerRuntime()
    state.timerAutoSubmitting = false
    setScreen('results')
    setStep('results')

    // Prepare payload for backend evaluation.
    const nowIso = new Date().toISOString()
    const dt = formatDateTime(nowIso)
    elements.rName.textContent = state.candidate.name
    elements.rEmail.textContent = state.candidate.email
    elements.rDate.textContent = dt.date
    elements.rTime.textContent = dt.time
    elements.resultsError.textContent = ''

    elements.resultsLoading.classList.remove('is-hidden')
    elements.resultsContent.classList.add('is-hidden')
    elements.dimensionList.innerHTML = ''
    elements.keyStrengths.innerHTML = ''
    elements.areasForImprovement.innerHTML = ''
    if (elements.overallSummary) {
      elements.overallSummary.textContent = ''
      elements.overallSummary.classList.add('is-hidden')
      elements.overallSummary.setAttribute('aria-hidden', 'true')
    }

    const payload = {
      name: state.candidate.name,
      email: state.candidate.email,
      responses: state.responses || [],
      timestamp: nowIso
    }
    markAttemptLock(state.candidate?.email, 'completed', {
      completedAt: nowIso
    })

    // Friendly loading messages cycling during the API call.
    const cycleMessages = [
      'Analyzing your communication style...',
      'Evaluating your teaching approach...',
      'Preparing your report...'
    ]
    let cycleIdx = 0
    elements.resultsLoading.classList.remove('is-hidden')
    elements.resultsContent.classList.add('is-hidden')
    elements.loadingMessage.textContent = cycleMessages[cycleIdx]
    const interval = setInterval(() => {
      cycleIdx = (cycleIdx + 1) % cycleMessages.length
      elements.loadingMessage.textContent = cycleMessages[cycleIdx]
    }, 1500)

    try {
      await speakText('One moment while we prepare your evaluation report.')
      const result = await apiEvaluate(payload)

      clearInterval(interval)
      hideProcessingOverlay()
      renderResults(result)
    } catch (err) {
      clearInterval(interval)
      console.error(err)
      elements.resultsError.textContent = err?.message || 'Unable to load results.'
      elements.resultsLoading.classList.add('is-hidden')
      elements.resultsContent.classList.remove('is-hidden')
    } finally {
      elements.resultsLoading.classList.add('is-hidden')
      elements.resultsContent.classList.remove('is-hidden')
    }
  }

  function tierForScore(score) {
    if (score >= 8) return 'good'
    if (score >= 5) return 'ok'
    return 'bad'
  }

  function setDonut(score) {
    const r = 62
    const c = 2 * Math.PI * r
    const pct = Math.max(0, Math.min(10, Number(score)))
    const dashOffset = c * (1 - pct / 10)

    elements.donutText.textContent = `${Math.round(pct * 10) / 10}`

    elements.donutFg.classList.remove('good', 'ok', 'bad')
    if (pct >= 8) elements.donutFg.classList.add('good')
    else elements.donutFg.classList.add('ok')
    // Red/orange handled by CSS variable fallback; we use inline stroke only via JS class.

    elements.donutFg.style.strokeDasharray = `${c} ${c}`
    elements.donutFg.style.strokeDashoffset = `${c}`
    elements.donutFg.style.transition = 'stroke-dashoffset 900ms ease'

    requestAnimationFrame(() => {
      elements.donutFg.style.strokeDashoffset = `${dashOffset}`
    })
  }

  function scoreToColorClass(score) {
    const t = tierForScore(score)
    if (t === 'good') return 'good'
    if (t === 'ok') return 'ok'
    return 'bad'
  }

  function renderDimension({ title, data }) {
    const dim = document.createElement('div')
    dim.className = 'bar-card'

    const score = Number(data?.score ?? 0)
    const tier = tierForScore(score)
    const scoreText = Number.isFinite(score) ? score.toFixed(0) : '0'

    dim.innerHTML = `
      <div class="bar-top">
        <div class="bar-title">${title}</div>
        <div class="bar-score ${tier}">${scoreText}/10</div>
      </div>

      <div class="bar-track" aria-label="${title} score ${scoreText} out of 10">
        <div class="bar-fill ${tier}" data-score="${score}"></div>
      </div>

      <div class="bar-comment">${escapeHtml(data?.comment || '')}</div>
      <blockquote class="quote">“${escapeHtml(data?.quote || '')}”</blockquote>
    `

    return dim
  }

  function escapeHtml(str) {
    return String(str || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;')
  }

  function animateDimensionBars(root) {
    const fillEls = root.querySelectorAll('.bar-fill[data-score]')
    fillEls.forEach((el) => {
      const s = Number(el.getAttribute('data-score') || 0)
      const pct = Math.max(0, Math.min(100, (s / 10) * 100))
      el.style.width = '0%'
      // Trigger reflow then animate.
      void el.offsetWidth
      el.style.width = `${pct}%`
    })
  }

  function setDecisionBadge(overallDecision) {
    const d = String(overallDecision || '')
    const isGood = /next round/i.test(d) || d === 'Move to Next Round'
    elements.decisionBadge.classList.remove('good', 'bad')
    elements.decisionBadge.textContent = d || ''
    if (isGood) {
      elements.decisionBadge.classList.add('good')
      elements.decisionBadge.textContent = '✓ Move to Next Round'
    } else {
      elements.decisionBadge.classList.add('bad')
      elements.decisionBadge.textContent = '✗ Not Recommended'
    }
  }

  function renderResults(result) {
    elements.resultsLoading.classList.add('is-hidden')
    elements.resultsContent.classList.remove('is-hidden')

    const overallScore = Number(result?.overall_score ?? 0)
    const overallDecision = result?.overall_decision
    if (elements.overallSummary) {
      const summary = String(result?.overall_summary || '').trim()
      elements.overallSummary.textContent = summary
      elements.overallSummary.classList.toggle('is-hidden', !summary)
      elements.overallSummary.setAttribute('aria-hidden', summary ? 'false' : 'true')
    }
    elements.keyStrengths.innerHTML = ''
    elements.areasForImprovement.innerHTML = ''

    // Donut.
    setDonut(overallScore)
    setDecisionBadge(overallDecision)

    // Dimensions.
    const dims = [
      { title: 'Communication Clarity', data: result?.communication_clarity },
      { title: 'Warmth & Empathy', data: result?.warmth_empathy },
      { title: 'Patience', data: result?.patience },
      { title: 'Ability to Simplify', data: result?.ability_to_simplify },
      { title: 'English Fluency', data: result?.english_fluency }
    ]

    elements.dimensionList.innerHTML = ''
    dims.forEach((d) => {
      const el = renderDimension(d)
      elements.dimensionList.appendChild(el)
    })

    // Animate dimension bars.
    animateDimensionBars(elements.dimensionList)

    // Bullet sections.
    const strengths = Array.isArray(result?.key_strengths)
      ? result.key_strengths.map(cleanFeedbackItem).filter(Boolean)
      : []
    const improvements = Array.isArray(result?.areas_for_improvement)
      ? result.areas_for_improvement.map(cleanFeedbackItem).filter(Boolean)
      : []

    strengths.slice(0, 3).forEach((s) => {
      const li = document.createElement('li')
      li.textContent = String(s)
      elements.keyStrengths.appendChild(li)
    })

    improvements.slice(0, 2).forEach((s) => {
      const li = document.createElement('li')
      li.textContent = String(s)
      elements.areasForImprovement.appendChild(li)
    })
  }

  function resetAll() {
    state.phase = 'welcome'
    state.stepKey = 'intro'
    state.coreIndex = 0
    state.awaitingFollowUp = false
    state.followUpCountForCurrent = 0
    state.currentAskedQuestion = ''
    state.currentCoreQuestion = ''
    state.disqualified = false
    state.disqualifyReason = ''
    state.currentRecord = null
    state.lastCheck = null
    state.lastWarmAck = null
    state.lastClosingAck = null
    state.responses = []

    stopSpeaking()
    clearQuestionTimerRuntime()
    state.timerAutoSubmitting = false
    hideProcessingOverlay()

    elements.transcript.value = ''
    elements.interviewError.textContent = ''
    elements.welcomeError.textContent = ''
    syncStartButtonState()

    setStep('intro')

    elements.questionText.textContent = ''
    elements.questionBadge.textContent = 'Interview Question'
    elements.waveform.classList.remove('recording')
    elements.micBtn.classList.remove('recording')
    elements.micBtn.setAttribute('aria-label', 'Start recording')
    stopWaveform()
    resetQuestionTimer()
    elements.recordInstruction.textContent = 'Click mic to answer'
    setInterviewControlsEnabled({
      micEnabled: true,
      reRecordEnabled: false,
      submitEnabled: false
    })

    elements.resultsError.textContent = ''
    elements.resultsContent.classList.add('is-hidden')
    elements.resultsLoading.classList.remove('is-hidden')
    elements.loadingMessage.textContent = ''
    elements.dimensionList.innerHTML = ''
    elements.keyStrengths.innerHTML = ''
    elements.areasForImprovement.innerHTML = ''
    if (elements.overallSummary) {
      elements.overallSummary.textContent = ''
      elements.overallSummary.classList.add('is-hidden')
      elements.overallSummary.setAttribute('aria-hidden', 'true')
    }

    setScreen('welcome')
  }

  function validateWelcome() {
    const name = String(elements.fullName.value || '').trim()
    const email = String(elements.email.value || '').trim()
    if (!name) {
      setError(elements.welcomeError, 'Please enter your full name.')
      return null
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError(elements.welcomeError, 'Please enter a valid email address.')
      return null
    }
    setError(elements.welcomeError, '')
    return { name, email }
  }

  function onStartInterview() {
    const data = validateWelcome()
    if (!data) return

    state.candidate = data
    setScreen('policy')
  }

  async function beginInterviewAfterPolicy() {
    if (!state.candidate?.name || !state.candidate?.email) {
      setScreen('welcome')
      setError(elements.welcomeError, 'Please enter your details before starting the interview.')
      return
    }

    state.disqualified = false
    state.disqualifyReason = ''
    state.interviewStartedAt = new Date().toISOString()
    state.responses = []
    resetTranscriptUi()
    resetQuestionTimer()

    setScreen('interview')
    elements.progressFill.style.width = '0%'

    elements.reRecordBtn.disabled = true
    elements.submitAnswerBtn.disabled = true
    setInterviewControlsEnabled({
      micEnabled: true,
      reRecordEnabled: false,
      submitEnabled: false
    })

    // Estimated time remaining updater.
    const EST_TOTAL_SECONDS = 420
    const tick = () => {
      const elapsedSeconds =
        (Date.now() - new Date(state.interviewStartedAt).getTime()) / 1000
      const remainingSeconds = Math.max(0, Math.round(EST_TOTAL_SECONDS - elapsedSeconds))
      const headerEl = document.getElementById('estimated-remaining')
      if (!headerEl) return
      const mm = Math.floor(remainingSeconds / 60)
      const ss = remainingSeconds % 60
      headerEl.textContent = `Est. remaining: ${mm}:${String(ss).padStart(2, '0')}`
    }
    tick()
    const interval = setInterval(tick, 1000)

    try {
      // Setup SpeechRecognition.
      state.recognition = initSpeechRecognition()
      if (!state.recognition) {
        setError(
          elements.interviewError,
          'Speech recognition is not available in this browser. Please try Chrome.'
        )
      }

      await speakGreetingAndBegin()
      if (state.phase !== 'interview') return

      // First core question.
      await startCoreQuestion(0)
      if (state.phase !== 'interview') return
      state.phase = 'interview'
      // Update interval until results.
      const stopWhenResults = setInterval(() => {
        if (state.phase === 'results') {
          clearInterval(interval)
          clearInterval(stopWhenResults)
        }
      }, 500)
    } catch (err) {
      clearInterval(interval)
      console.error(err)
      setError(elements.interviewError, err?.message || 'Unable to start interview.')
    }
  }

  function attachEvents() {
    elements.startBtn.addEventListener('click', onStartInterview)
    elements.policyOkBtn.addEventListener('click', beginInterviewAfterPolicy)
    elements.fullName.addEventListener('input', () => {
      if (elements.welcomeError.textContent) setError(elements.welcomeError, '')
      syncStartButtonState()
    })
    elements.email.addEventListener('input', () => {
      if (elements.welcomeError.textContent) setError(elements.welcomeError, '')
      syncStartButtonState()
    })

    // Mic button starts recording; user cannot stop it manually.
    elements.micBtn.addEventListener('click', () => {
      if (!state.recognition) {
        setError(
          elements.interviewError,
          'Microphone not available. Please use Chrome and allow microphone access.'
        )
        return
      }

      if (!state.recording) {
        // Candidate starts recording when ready.
        stopSpeaking()
        // Browser permission prompts can temporarily shift focus; do not disqualify for that.
        armPermissionPromptGuard(6000)
        startRecording()
      } else {
        setError(
          elements.interviewError,
          'Recording will stop automatically after 60 seconds. You can submit early anytime.'
        )
      }
    })

    elements.reRecordBtn.addEventListener('click', () => {
      if (!state.recognition) return
      stopSpeaking()
      if (state.recording) {
        state.suppressOnEnd = true
        state.recording = false
        stopRecording()
      }
      resetTranscriptUi()
      // Prevent stale speech fragments from old session appearing in the new attempt.
      state.ignoreResultsUntilMs = Date.now() + 350
      setInterviewControlsEnabled({
        micEnabled: true,
        reRecordEnabled: true,
        submitEnabled: false
      })
      startRecording({ restartTimer: false })
    })

    elements.submitAnswerBtn.addEventListener('click', () => {
      submitCurrentAnswer()
    })

    elements.printBtn.addEventListener('click', () => {
      window.print()
    })

    elements.newInterviewBtn.addEventListener('click', () => {
      resetAll()
    })

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        // Stop TTS immediately when user leaves the tab.
        stopSpeaking()
        if (shouldIgnoreFocusLoss()) return
        endInterviewAsRejected('You left the interview tab/window during the interview.')
      }
    })

    // Intentionally do not disqualify on window blur.
    // Browser UI (extensions, permission UI, omnibox interactions) can trigger blur
    // even while candidate remains on the same tab.
  }

  // Bugfix: fix transcript state variables during reset.
  // (Keeps the code centralized, but ensures no stale interim text.)
  function boot() {
    state.responses = []
    setScreen('welcome')
    setStep('intro')
    setInterviewControlsEnabled({
      micEnabled: true,
      reRecordEnabled: false,
      submitEnabled: false
    })
    syncStartButtonState()
    attachEvents()
    resetAll()
  }

  window.addEventListener('load', boot)
})()

