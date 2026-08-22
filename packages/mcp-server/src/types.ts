/** Distribute Omit over each member of a discriminated union */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

// Messages sent from MCP server → Extension (via WebSocket)
export type ServerMessage =
  | { type: "navigate"; requestId: string; url: string; newTab?: boolean; background?: boolean; expect_selector?: string }
  | { type: "switch_to_tab"; requestId: string; query: string }
  | { type: "click_via_fiber"; requestId: string; textHint?: string; selector?: string; nth?: number; within_selector?: string; near_text?: string; in_dialog?: boolean; dialog_query?: string }
  | { type: "close_tab"; requestId: string; query?: string }
  | { type: "close_other_tabs"; requestId: string; keep_query?: string }
  | { type: "screenshot"; requestId: string; grid?: boolean; allow_fullscreen?: boolean }
  | { type: "find_highlight"; requestId: string; text: string; message: string; valueToType?: string }
  | {
      type: "highlight_region";
      requestId: string;
      selector?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      message: string;
      valueToType?: string;
      frame?: string;
    }
  | { type: "read_element"; requestId: string; textHint: string }
  | { type: "clear"; requestId: string }
  // Flow control — reactive progression
  | { type: "start_click_watch"; requestId: string; timeout: number; redispatch?: boolean }
  | { type: "fill_input"; requestId: string; textHint: string; value: string; nth?: number; exact?: boolean }
  | {
      type: "click_element";
      requestId: string;
      textHint?: string;
      selector?: string;
      nth?: number;
      until_selector?: string;
      until_url_contains?: string;
      until_text_contains?: string;
      until_url_changes?: boolean;
      until_timeout_ms?: number;
      expect_submit?: boolean;
      within_selector?: string;
      near_text?: string;
      try_fiber?: boolean;
      activity_timeout_ms?: number;
      skip_activity_probe?: boolean;
      via?: "auto" | "cdp" | "fiber";
      in_dialog?: boolean;
      dialog_query?: string;
      wait_until_enabled_ms?: number;
      pierce_overlays?: boolean;
      frame?: string;
    }
  | {
      type: "click_at_coordinates";
      requestId: string;
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      double?: boolean;
      pierce?: boolean;
      pierce_layers?: number;
      frame?: string;
    }
  // ChromeBoost cursor + HUD control
  | {
      type: "hover";
      requestId: string;
      selector?: string;
      text?: string;
      x?: number;
      y?: number;
      settle_ms?: number;
      frame?: string;
    }
  | {
      type: "drag";
      requestId: string;
      from_selector?: string;
      from_x?: number;
      from_y?: number;
      to_selector?: string;
      to_x?: number;
      to_y?: number;
      steps?: number;
      hold_ms?: number;
      frame?: string;
    }
  | { type: "probe_point"; requestId: string; x: number; y: number }
  | {
      type: "hud_control";
      requestId: string;
      action: "show" | "hide" | "collapse" | "expand" | "dock" | "move" | "status" | "state";
      corner?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
      x?: number;
      y?: number;
      text?: string;
    }
  | { type: "prepare_click_target"; requestId: string; textHint?: string; selector?: string; nth?: number; within_selector?: string; near_text?: string; in_dialog?: boolean; dialog_query?: string }
  | { type: "post_click_inspect"; requestId: string }
  | { type: "scroll_page"; requestId: string; direction: "down" | "up"; amount: number }
  | { type: "get_page_text"; requestId: string; selector?: string; startIndex?: number ; frame?: string; include_frames?: boolean }
  | { type: "get_page_html"; requestId: string; selector?: string; max_chars?: number; frame?: string }
  | { type: "wait_for_selector"; requestId: string; selector: string; timeout: number; refresh?: number; shadow_root?: boolean }
  | { type: "wait_for_change"; requestId: string; selector: string; timeout: number; settle?: number }
  | { type: "execute_script"; requestId: string; code: string; tab_query?: string; pierce_shadow?: boolean; timeout_ms?: number; frame?: string }
  | { type: "get_elements"; requestId: string; frame?: string }
  | { type: "get_form_fields"; requestId: string; only_empty?: boolean; frame?: string }
  | { type: "scroll_to_element"; requestId: string; query: string; frame?: string }
  | { type: "save_page_state"; requestId: string }
  | { type: "restore_page_state"; requestId: string; state: PageFieldState[] }
  | { type: "list_tabs"; requestId: string }
  | { type: "fill_form"; requestId: string; fields: Array<{ label: string; value: string }>; exact?: boolean }
  | { type: "set_file_input"; requestId: string; hint: string; filePath: string; waitMs?: number; verifySelector?: string }
  | { type: "type_text"; requestId: string; text: string; frame?: string; into_selector?: string; clear_first?: boolean }
  | { type: "inspect_request_headers"; requestId: string; url: string; new_tab?: boolean }
  | { type: "react_set_input"; requestId: string; selector: string; value: string; frame?: string }
  | {
      type: "react_call_prop";
      requestId: string;
      selector: string;
      prop_name: string;
      args: unknown[];
      max_depth: number;
      frame?: string;
    }
  | {
      type: "find_text";
      requestId: string;
      query: string;
      max?: number;
      scope_selector?: string;
      regex?: boolean;
      visible_only?: boolean;
      context_chars?: number;
      frame?: string;
      in_dialog?: boolean;
      dialog_query?: string;
      whole_word?: boolean;
    }
  | {
      type: "find_input";
      requestId: string;
      query: string;
      type_filter?: string;
      max?: number;
      exact?: boolean;
      frame?: string;
    }
  | {
      type: "wait_for_text";
      requestId: string;
      query: string | string[];
      timeout_ms?: number;
      scope_selector?: string;
      regex?: boolean;
      frame?: string;
      since?: "now";
      whole_word?: boolean;
    }
  | {
      type: "fetch_url";
      requestId: string;
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      binary?: boolean;
      timeout_ms?: number;
      max_bytes?: number;
    }
  | {
      type: "download_file";
      requestId: string;
      url: string;
      filename?: string;
      timeout_ms?: number;
    }
  | {
      type: "read_attachment";
      requestId: string;
      url: string;
      format?: string;
      max_chars?: number;
    }
  | { type: "list_frames"; requestId: string }
  | { type: "frame_origin"; requestId: string; frame: string }
  | { type: "frame_identity"; requestId: string; frame: string };

/**
 * ChromeBoost: description of an element that is covering a click target, or
 * that sits at a probed coordinate. Mirrors the content script's
 * `content/hittest.ts` shape.
 */
export type OccluderInfo = {
  tag: string;
  selector: string;
  text: string;
  z_index: string;
  position: string;
  /** Covers ≥85% of the viewport — a modal backdrop / scrim. */
  full_screen_scrim: boolean;
  /** `position: fixed` or `sticky` — scrollable-out-from-under. */
  pinned: boolean;
  /** Visually invisible but still intercepting — a click-away catcher. */
  transparent: boolean;
};

export type PageFieldState = {
  selector: string;
  type: string;
  value: string;
  checked?: boolean;
};

// Messages sent from Extension → MCP server
export type ClientMessage =
  | { type: "ready" }
  | { type: "progress"; requestId: string; phase?: string; detail?: string }
  | {
      type: "screenshot_response";
      requestId: string;
      image: string;
      width: number;
      height: number;
      viewport?: { width: number; height: number };
      page?: { width: number; height: number };
      scroll?: { x: number; y: number };
    }
  | { type: "find_highlight_response"; requestId: string; found: boolean }
  | { type: "action_done"; requestId: string }
  | { type: "read_response"; requestId: string; value: string | null }
  | {
      type: "click_detected";
      requestId: string;
      target?: { selector: string; text: string; tag: string; x: number; y: number } | null;
    }
  | {
      type: "navigation_complete";
      requestId: string;
      url: string;
      target?: { selector: string; text: string; tag: string; x: number; y: number } | null;
    }
  | { type: "fill_response"; requestId: string; success: boolean; message: string; matched?: string }
  | {
      type: "click_element_response";
      requestId: string;
      success: boolean;
      message: string;
      before_url?: string;
      after_url?: string;
      navigated?: boolean;
      scope_missed?: boolean;
      silently_rejected?: boolean;
      fiber_attempted?: boolean;
      recovered_via?: string;
      request_in_flight?: boolean;
      dialog_opened?: { kind: string; label: string; primary_action: string };
      phase_timed_out?: string;
      target_disabled?: boolean;
      disabled_state?: {
        disabled: boolean;
        aria_disabled: string | null;
        pointer_events: string;
        opacity: string;
        visible: boolean;
      };
      focused_after?: {
        tag: string;
        id: string;
        name: string;
        type: string;
        aria_label: string;
        value_preview: string;
      } | null;
    }
  | {
      type: "click_at_coordinates_response";
      requestId: string;
      success: boolean;
      message: string;
      before_url?: string;
      after_url?: string;
      navigated?: boolean;
      /** ChromeBoost: the element that actually received the cursor. */
      hit?: { selector: string; tag: string; text: string };
      /**
       * Set when CDP dispatch couldn't complete and a synthetic (isTrusted=false)
       * click was used instead — the caller needs to know the click may not be
       * honoured by an isTrusted-gated target.
       */
      degraded?: boolean;
    }
  // ─── ChromeBoost cursor + HUD responses ───────────────────────────────────
  | {
      type: "hover_response";
      requestId: string;
      success: boolean;
      message: string;
      x?: number;
      y?: number;
    }
  | {
      type: "drag_response";
      requestId: string;
      success: boolean;
      message: string;
      from?: { x: number; y: number; label: string };
      to?: { x: number; y: number; label: string };
      navigated?: boolean;
    }
  | {
      type: "probe_point_response";
      requestId: string;
      x: number;
      y: number;
      stack: Array<{ tag: string; selector: string; text: string; z_index: string; position: string }>;
      top?: OccluderInfo;
      in_iframe: boolean;
      /** Addressable path of the frame the hit lives in, or "" for the top frame. */
      frame?: string;
    }
  | {
      type: "hud_control_response";
      requestId: string;
      success: boolean;
      message: string;
      state?: { x: number; y: number; collapsed: boolean; hidden: boolean; present: boolean };
    }
  | {
      type: "page_text_response";
      requestId: string;
      text: string;
      selector_missed?: boolean;
      selector_in_shadow?: boolean;
      shadow_hosts_seen?: number;
      viewport?: { width: number; height: number };
      page?: { width: number; height: number };
      scroll?: { x: number; y: number };
    }
  | {
      type: "page_html_response";
      requestId: string;
      html: string;
      total_chars: number;
      truncated: boolean;
      selector_missed?: boolean;
      selector_in_shadow?: boolean;
    }
  | { type: "script_response"; requestId: string; result: string; alert?: string | null; context?: "main"; navigated?: boolean; reauthorized?: boolean }
  | { type: "error"; requestId: string; message: string }
  | { type: "elements_response"; requestId: string; elements: Array<{ index: number; type: string; label: string; value: string; x: number; y: number; width: number; height: number }> }
  | {
      type: "form_fields_response";
      requestId: string;
      fields: Array<{ index: number; type: string; label: string; value: string; y: number; selector: string; required?: boolean; empty?: boolean }>;
      warning?: string;
      captcha?: { kind: "recaptcha" | "turnstile" | "hcaptcha"; sitekey: string | null } | null;
      oauthIndicators?: string[];
    }
  | { type: "save_state_response"; requestId: string; state: PageFieldState[] }
  | { type: "tabs_response"; requestId: string; tabs: Array<{ index: number; title: string; url: string; active: boolean }> }
  | { type: "switch_to_tab_response"; requestId: string; success: boolean; message: string; url?: string; title?: string }
  | { type: "fill_form_response"; requestId: string; results: Array<{ label: string; success: boolean; message: string; matched?: string }>; succeeded: number; total: number }
  | {
      type: "find_text_response";
      requestId: string;
      matches: Array<{
        text: string;
        context: string;
        selector: string;
        tag: string;
        role: string | null;
        clickable: boolean;
        position: { x: number; y: number; width: number; height: number } | null;
      }>;
      total_matches: number;
      hidden_count?: number;
      truncated: boolean;
      scope_missed?: boolean;
      frame_error?: string;
    }
  | {
      type: "find_input_response";
      requestId: string;
      fields: Array<{
        label: string;
        placeholder: string;
        type: string;
        value: string;
        under?: string;
        position: { x: number; y: number; width: number; height: number } | null;
        match_kind: string;
      }>;
      total_matches: number;
      truncated: boolean;
      frame_error?: string;
    }
  | {
      type: "wait_for_text_response";
      requestId: string;
      found: boolean;
      selector?: string;
      text?: string;
      context?: string;
      matched_query?: string;
      matched_index?: number;
      elapsed_ms: number;
      last_text?: string;
      initial_match_warning?: string;
      frame_error?: string;
    }
  | {
      type: "fetch_url_response";
      requestId: string;
      status: number;
      status_text: string;
      headers: Record<string, string>;
      content_type: string;
      body_text?: string;
      body_base64?: string;
      truncated: boolean;
      total_bytes: number;
      anti_bot_detected?: string | null;
    }
  | {
      type: "download_file_response";
      requestId: string;
      path: string;
      mime: string;
      size: number;
    }
  | {
      type: "read_attachment_response";
      requestId: string;
      text: string;
      format: string;
      total_chars: number;
      truncated: boolean;
      mime: string;
    }
  | {
      type: "list_frames_response";
      requestId: string;
      frames: Array<{
        index: number;
        /** Addressable path; `a >>> b` for a nested frame. Accepted verbatim as any tool's `frame`. */
        selector: string;
        /** 1 for a top-level frame, 2 for a frame inside a frame, and so on. */
        depth?: number;
        src: string;
        origin: string;
        title: string;
        accessible: boolean;
        cross_origin?: boolean;
        /** Current document URL, for same-origin frames whose src has since navigated. */
        url?: string;
        hint?: string;
        x: number;
        y: number;
        width: number;
        height: number;
        /** Frame content-box origin in top-viewport pixels; the base for frame-relative coordinates. */
        content_origin_x?: number;
        content_origin_y?: number;
      }>;
      shadow_hosts?: Array<{ selector: string; open: boolean; depth: number }>;
    }
  | {
      type: "frame_origin_response";
      requestId: string;
      found: boolean;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      cross_origin?: boolean;
      message?: string;
    }
  | {
      type: "frame_identity_response";
      requestId: string;
      found: boolean;
      src?: string;
      url?: string;
      cross_origin?: boolean;
      message?: string;
    };
