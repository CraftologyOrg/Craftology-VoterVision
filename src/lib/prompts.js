const PROMPTS = {
  find_submit_button: `This is a screenshot of a Minecraft server voting page. Find the main vote or submit button on the page. Respond ONLY with JSON in this exact format, no other text:
{"found": true, "text": "button text", "approximate_position": "center", "description": "brief description of the button", "likely_selector_hint": "button with text 'Vote'"}
If no vote/submit button is visible, respond with: {"found": false}
Use one of these positions: "center", "top", "bottom", "left", "right", "unknown".`,

  detect_captcha: `This is a screenshot of a Minecraft server voting page. Answer ONLY whether a CAPTCHA or verification widget is visibly present (checkbox challenge, image grid, "I'm not a robot", hCaptcha/reCAPTCHA/Turnstile-style box, etc.). Do NOT guess the captcha provider or type — another system already knows the type.

Respond ONLY with JSON in this exact format, no other text:
{"present": true, "active": true, "description": "brief description of what you see", "position": "center"}
If no captcha or verification widget is visible, respond with:
{"present": false, "active": false, "description": "no captcha visible", "position": "unknown"}
Set "active" to false if a captcha area appears hidden, grayed out, or not yet interactive.
Use one of these positions: "center", "top", "bottom", "left", "right", "unknown".`,

  check_page_ready: `This is a screenshot of a Minecraft server voting page. Determine if the page has fully loaded and is ready for user interaction. Look for: visible forms, input fields, buttons, and absence of loading spinners or overlays. Respond ONLY with JSON in this exact format, no other text:
{"ready": true, "reason": "explanation of why page is ready or not", "blocking_elements": []}
If something is blocking interaction, list those elements in blocking_elements like: ["loading spinner visible", "overlay present"].`,

  find_input_fields: `This is a screenshot of a Minecraft server voting page. Find all visible text input fields on the page, especially any username or player name fields. Respond ONLY with JSON in this exact format, no other text:
{"fields": [{"type": "username", "label": "field label text", "approximate_position": "center", "placeholder": "placeholder text if visible", "required": true}]}
For type use one of: "username", "email", "server", "other".
If no input fields are visible, respond with: {"fields": []}
Use one of these positions: "top", "center", "bottom", "unknown".`,

  detect_vote_result: `This is a screenshot of a Minecraft server voting page after a vote was submitted. Determine the outcome of the vote. Look for success messages, error messages, "already voted" notices, IP blocks, or captcha requirements. Respond ONLY with JSON in this exact format, no other text:
{"outcome": "success", "message": "the visible text indicating the result", "can_retry": false, "cooldown_until_iso": "", "cooldown_remaining_seconds": null}
For outcome use one of: "success", "already_voted", "ip_blocked", "captcha_required", "error", "unknown".
Set can_retry to true only if the page suggests trying again is possible.
Cooldown timing (strict):
- Set cooldown_remaining_seconds and/or cooldown_until_iso ONLY when the screenshot shows a visible countdown, timer, or explicit wait duration (e.g. "vote again in 4h 59m", "12 hours", a live timer).
- For generic "already voted" / "someone has already voted" messages with NO visible timer or duration, leave cooldown_remaining_seconds: null and cooldown_until_iso: "".
- Do NOT infer timing from URL IDs, server names, banners, ads, or unrelated numbers on the page.
- Maximum cooldown is 24 hours (86400 seconds). Never return more than that.
If timing cannot be read reliably from a visible duration, use cooldown_remaining_seconds: null and cooldown_until_iso: "".`,

  confirm_vote: `This is a screenshot taken after an automated vote submission on a Minecraft server voting page. Decide whether the vote should be counted as confirmed for the user's dashboard.

Respond ONLY with JSON in this exact format, no other text:
{"outcome": "success", "confirmed": true, "message": "visible evidence", "can_retry": false, "interference": "none", "wait_seconds": null}

Rules:
- Use outcome "success" only when the page visibly says the vote was accepted, recorded, counted, submitted successfully, or thanks the user for voting (e.g. "SUCCESS", "vote has been successfully sent").
- Use outcome "already_voted" when the page says the user/player/IP has already voted today, already claimed the vote, must wait until tomorrow, or can vote again later. This counts as confirmed because the vote site recognizes today's vote state.
- Use outcome "processing" when the vote is still in progress: visible countdown/timer, progress bar, "processing your vote", "hang on", "please wait", "do not close this tab", a mostly blank/white page right after submit with no final message yet, or similar — WITHOUT a final success or failure message yet. Set confirmed false, can_retry true, interference "processing_modal", and wait_seconds to the best visible countdown (1-60) or null if unknown.
- Do NOT use "interference" for that in-progress processing state. Reserve outcome "interference" for blockers: unsolved captcha, Cloudflare/Turnstile challenge blocking submit, network error, anti-bot check, disabled submit, or another required action before the vote can complete.
- Use outcome "failure" when the page clearly says the vote failed, username/player is invalid, captcha was incorrect, submission was rejected, or the vote could not be registered.
- Use outcome "unknown" only when there is no clear visible evidence.
- Set confirmed to true only for "success" or "already_voted"; otherwise false.
- Keep message short and quote or summarize only the visible evidence.`,

  locate_captcha_checkbox: `This is a screenshot of a Minecraft server voting page. Locate the captcha checkbox center as precisely as possible, especially for hCaptcha/reCAPTCHA style "I am human" widgets.

Respond ONLY with JSON in this exact format, no other text:
{"found": true, "provider_hint": "hcaptcha", "checkbox_center_norm": {"x": 0.5, "y": 0.5}, "checkbox_bbox_norm": {"x": 0.4, "y": 0.4, "width": 0.1, "height": 0.1}, "iframe_hint": true, "description": "small checkbox at left of 'I am human'"}

Rules:
- All coordinate values must be normalized 0..1 relative to the full screenshot.
- If unsure about provider, set provider_hint to "unknown".
- If checkbox is not visible, respond with:
{"found": false, "provider_hint": "unknown", "checkbox_center_norm": {"x": 0.5, "y": 0.5}, "checkbox_bbox_norm": {"x": 0, "y": 0, "width": 0, "height": 0}, "iframe_hint": false, "description": "captcha checkbox not visible"}`,

  locate_consent_checkbox: `This is a screenshot of a Minecraft server voting page. Locate the small HTML checkbox the user must tick to agree to the site's Privacy Policy, Terms of Service, or similar legal consent ("I agree...", "I agree to ... Privacy Policy").

This is NOT an hCaptcha/reCAPTCHA/Cloudflare widget — look for a normal square checkbox next to legal/consent text near the vote form.

Respond ONLY with JSON in this exact format, no other text:
{"found": true, "provider_hint": "consent", "checkbox_center_norm": {"x": 0.5, "y": 0.5}, "checkbox_bbox_norm": {"x": 0.4, "y": 0.4, "width": 0.1, "height": 0.1}, "iframe_hint": false, "description": "unchecked square left of privacy policy text"}

Rules:
- All coordinate values must be normalized 0..1 relative to the full screenshot.
- Aim for the center of the square checkbox, not the hyperlink text.
- provider_hint is usually "consent".
- If no such consent checkbox is visible, respond with:
{"found": false, "provider_hint": "unknown", "checkbox_center_norm": {"x": 0.5, "y": 0.5}, "checkbox_bbox_norm": {"x": 0, "y": 0, "width": 0, "height": 0}, "iframe_hint": false, "description": "no consent checkbox visible"}`,

  classify_vote_failure: `You are analyzing why an automated Minecraft server list vote failed. You receive a screenshot of the browser and optional additional context that may include a truncated HTML excerpt, the target vote URL, the player username, the autovoter's coarse failure-type hint, and the client's error message.

Classify the primary reason the vote did not succeed. Use the screenshot as primary evidence; use HTML/text only as supporting evidence.

Respond ONLY with JSON in this exact format, no other text:
{"category": "other", "summary": "one or two sentences explaining the failure", "evidence_quote": "short visible text from the page if any", "suggested_autovoter_failure_type": "UNKNOWN", "cooldown_until_iso": "", "cooldown_remaining_seconds": null}

Rules for "category" (pick the single best match):
- "already_voted" — user/player already voted, come back tomorrow, cooldown, limit reached in a vote-success sense.
- "captcha_failed" — captcha incorrect, unsolved, invalid, verification failed, bot check failed.
- "step_missing" — required field/button/step not present or not completed (e.g. missing submit, wrong stage).
- "site_error" — site returned an error page, 4xx/5xx style message, maintenance, generic server error.
- "network_or_load" — blank page, timeout, connection error, endless loading, TLS/proxy style page errors visible in UI.
- "ip_blocked" — IP/geo/VPN blocked or rate limited by the vote site.
- "other" — none of the above clearly fit.

For "suggested_autovoter_failure_type", echo the closest Autovoter enum string if inferable: PROXY_BLOCKED, CAPTCHA_UNSOLVED, CAPTCHA_UNSOLVABLE, CAPTCHA_REJECTED, PAGE_LOAD_FAILED, PAGE_CLOSED, FORM_ERROR, VOTE_REJECTED, IP_RELATED, UNKNOWN. If unsure, use UNKNOWN.

Cooldown timing (strict, same as detect_vote_result):
- Fill cooldown_remaining_seconds and/or cooldown_until_iso ONLY when the screenshot shows a visible countdown, timer, or explicit wait duration.
- For generic "already voted" messages with no timer, leave both empty/null.
- Do NOT infer timing from URL IDs, banners, or unrelated numbers. Maximum cooldown is 24 hours (86400 seconds).`,
};

const VALID_TASKS = new Set(Object.keys(PROMPTS));
export const VALID_TASK_LIST = Object.freeze(Object.keys(PROMPTS));

export function getPrompt(task, context) {
  const base = PROMPTS[task];
  if (!base) return null;
  if (context) {
    return `${base}\n\nAdditional context:\n${context}`;
  }
  return base;
}

export function isValidTask(task) {
  return VALID_TASKS.has(task);
}
