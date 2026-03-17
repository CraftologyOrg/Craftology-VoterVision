const PROMPTS = {
  find_submit_button: `This is a screenshot of a Minecraft server voting page. Find the main vote or submit button on the page. Respond ONLY with JSON in this exact format, no other text:
{"found": true, "text": "button text", "approximate_position": "center", "description": "brief description of the button", "likely_selector_hint": "button with text 'Vote'"}
If no vote/submit button is visible, respond with: {"found": false}
Use one of these positions: "center", "top", "bottom", "left", "right", "unknown".`,

  detect_captcha: `This is a screenshot of a Minecraft server voting page. Determine if there is any CAPTCHA widget visible on this page. Look for reCAPTCHA checkboxes, hCaptcha, Cloudflare Turnstile, image grids, text challenges, or any other verification widget. Respond ONLY with JSON in this exact format, no other text:
{"present": true, "active": true, "type": "recaptcha_v2", "description": "brief description", "position": "center"}
If no captcha is visible, respond with: {"present": false, "active": false, "type": "none", "description": "no captcha visible", "position": "unknown"}
For type use one of: "recaptcha_v2", "recaptcha_v3", "hcaptcha", "turnstile", "funcaptcha", "image_grid", "text", "unknown", "none".
Set "active" to false if captcha elements appear hidden, grayed out, or not yet triggered.`,

  check_page_ready: `This is a screenshot of a Minecraft server voting page. Determine if the page has fully loaded and is ready for user interaction. Look for: visible forms, input fields, buttons, and absence of loading spinners or overlays. Respond ONLY with JSON in this exact format, no other text:
{"ready": true, "reason": "explanation of why page is ready or not", "blocking_elements": []}
If something is blocking interaction, list those elements in blocking_elements like: ["loading spinner visible", "overlay present"].`,

  find_input_fields: `This is a screenshot of a Minecraft server voting page. Find all visible text input fields on the page, especially any username or player name fields. Respond ONLY with JSON in this exact format, no other text:
{"fields": [{"type": "username", "label": "field label text", "approximate_position": "center", "placeholder": "placeholder text if visible", "required": true}]}
For type use one of: "username", "email", "server", "other".
If no input fields are visible, respond with: {"fields": []}
Use one of these positions: "top", "center", "bottom", "unknown".`,

  detect_vote_result: `This is a screenshot of a Minecraft server voting page after a vote was submitted. Determine the outcome of the vote. Look for success messages, error messages, "already voted" notices, IP blocks, or captcha requirements. Respond ONLY with JSON in this exact format, no other text:
{"outcome": "success", "message": "the visible text indicating the result", "can_retry": false}
For outcome use one of: "success", "already_voted", "ip_blocked", "captcha_required", "error", "unknown".
Set can_retry to true only if the page suggests trying again is possible.`,
};

const VALID_TASKS = new Set(Object.keys(PROMPTS));

export function getPrompt(task, context) {
  const base = PROMPTS[task];
  if (!base) return null;
  if (context) {
    return `${base}\nAdditional context: ${context}`;
  }
  return base;
}

export function isValidTask(task) {
  return VALID_TASKS.has(task);
}
