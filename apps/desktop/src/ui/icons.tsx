import type { ReactNode } from "react";
import { DEEPSEEK_PATH, ZAI_PATH } from "./model-brand-paths";

function Icon({ children }: { readonly children: ReactNode }) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      {children}
    </svg>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path
        d="M10 4.25v11.5M4.25 10h11.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </Icon>
  );
}

export function TerminalIcon() {
  return (
    <Icon>
      <rect
        x="3.3"
        y="4.1"
        width="13.4"
        height="11.8"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path
        d="m6.2 7.4 2.2 2.1-2.2 2.1M9.7 12h3.7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
    </Icon>
  );
}

export function BrowserPreviewIcon() {
  return (
    <Icon>
      <rect
        x="3.1"
        y="4.1"
        width="13.8"
        height="11.8"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path d="M3.4 7.4h13.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.35" />
      <path
        d="M6 5.75h.02M8.15 5.75h.02"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
      <path
        d="m8.1 10.1 1.8 1.8 3.5-3.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.45"
      />
    </Icon>
  );
}

export function SidebarToggleIcon() {
  return (
    <Icon>
      <rect
        x="3.4"
        y="4.1"
        width="13.2"
        height="11.8"
        rx="2.2"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path d="M7.4 4.2v11.6" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M11 8.1 8.9 10l2.1 1.9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
    </Icon>
  );
}

export function SidePanelIcon() {
  return (
    <Icon>
      <rect
        x="3.2"
        y="3.6"
        width="13.6"
        height="12.8"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path d="M12.2 3.6v12.8" stroke="currentColor" strokeWidth="1.35" />
    </Icon>
  );
}

export function MaximizeIcon() {
  return (
    <Icon>
      <path
        d="M6.1 3.8H3.8v2.3M13.9 3.8h2.3v2.3M6.1 16.2H3.8v-2.3M13.9 16.2h2.3v-2.3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.45"
      />
      <path d="M7 7h6v6H7z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.25" />
    </Icon>
  );
}

export function MinimizeIcon() {
  return (
    <Icon>
      <path
        d="M3.9 7.1h3.2V3.9M16.1 7.1h-3.2V3.9M3.9 12.9h3.2v3.2M16.1 12.9h-3.2v3.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.45"
      />
      <path
        d="M7.7 7.7h4.6v4.6H7.7z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon>
      <path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </Icon>
  );
}

export function ArrowUpIcon() {
  return (
    <Icon>
      <path d="M10 15.2V4.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      <path
        d="M5.8 9 10 4.8 14.2 9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </Icon>
  );
}

/**
 * Owner-supplied ASCII Pegasus; one cached bitmap, no glyph animation or redraw loop.
 * Served from public/ so this module stays free of import.meta and loads under unit tests.
 */
const PEGASUS_LOGO = "./pegasus.png";
export function AppLogo({ className = "" }: { readonly className?: string }) {
  return (
    <img
      aria-hidden="true"
      alt=""
      className={className}
      src={PEGASUS_LOGO}
      width={32}
      height={32}
      draggable={false}
      decoding="async"
    />
  );
}

export function AppBrand() {
  return (
    <div className="sidebar__brand">
      <span className="sidebar__brand-icon">
        <AppLogo className="sidebar__brand-mark" />
      </span>
      <span className="sidebar__brand-name">Pegasus</span>
    </div>
  );
}

// Provider marks: OpenAI from @lobehub/icons-static-svg 1.95.1, Claude from simple-icons 16.35.0.
function BrandIcon({ path }: { readonly path: string }) {
  return (
    <svg aria-hidden="true" fill="currentColor" fillRule="evenodd" viewBox="0 0 24 24">
      <path d={path} />
    </svg>
  );
}

const OPENAI_PATH =
  "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z";
const CLAUDE_PATH =
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";

/** Gemini's four-point spark, for the Antigravity route. */
const GEMINI_PATH =
  "M12 1.5c.55 5.55 4.95 9.95 10.5 10.5-5.55.55-9.95 4.95-10.5 10.5C11.45 16.95 7.05 12.55 1.5 12 7.05 11.45 11.45 7.05 12 1.5Z";

/** The provider's logo for Claude/Anthropic, OpenAI/Codex and Antigravity routes, else a generic model glyph. */
export function ProviderIcon({
  providerId,
  modelId,
}: {
  readonly providerId: string;
  readonly modelId?: string;
}) {
  if (/^deepseek\//i.test(modelId ?? providerId)) return <BrandIcon path={DEEPSEEK_PATH} />;
  if (/^(z-ai\/|glm)/i.test(modelId ?? providerId)) return <BrandIcon path={ZAI_PATH} />;
  if (providerId === "openscale")
    return (
      <svg
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        viewBox="0 0 32 32"
      >
        <rect x="5.5" y="5.5" width="21" height="21" />
        <rect x="5.5" y="12.5" width="14" height="14" />
        <rect x="5.5" y="19.5" width="7" height="7" />
      </svg>
    );
  if (/claude|anthropic/i.test(providerId)) return <BrandIcon path={CLAUDE_PATH} />;
  if (/openai|codex|gpt/i.test(providerId)) return <BrandIcon path={OPENAI_PATH} />;
  if (/antigravity|gemini|google/i.test(providerId)) return <BrandIcon path={GEMINI_PATH} />;
  return <ModelIcon />;
}

export function StopSquareIcon() {
  return (
    <Icon>
      <rect x="5.2" y="5.2" width="9.6" height="9.6" rx="1.6" fill="currentColor" />
    </Icon>
  );
}

export function FolderIcon() {
  return (
    <Icon>
      <path
        d="M2.75 6.5a1.75 1.75 0 0 1 1.75-1.75h3.1l1.5 1.7h6.4a1.75 1.75 0 0 1 1.75 1.75v5.3a1.75 1.75 0 0 1-1.75 1.75H4.5a1.75 1.75 0 0 1-1.75-1.75V6.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </Icon>
  );
}

export function FileIcon() {
  return (
    <Icon>
      <path
        d="M6.1 3.9h5.6l2.3 2.3v8a1.7 1.7 0 0 1-1.7 1.7H6.1a1.7 1.7 0 0 1-1.7-1.7V5.6a1.7 1.7 0 0 1 1.7-1.7Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path
        d="M11.7 3.9v2.4h2.3M7.2 9.15h5.6M7.2 11.8h4.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.35"
      />
    </Icon>
  );
}

export function ArchiveIcon() {
  return (
    <Icon>
      <path
        d="M4.1 5.1h11.8l-.8 10.1a1.2 1.2 0 0 1-1.2 1.1H6.1a1.2 1.2 0 0 1-1.2-1.1L4.1 5.1Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path
        d="M3.4 4.1h13.2v2.4H3.4zM7.1 9.15h5.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.35"
      />
    </Icon>
  );
}

export function RestoreIcon() {
  return (
    <Icon>
      <path
        d="M4.1 6.15h11.8l-.8 9.05a1.2 1.2 0 0 1-1.2 1.1H6.1a1.2 1.2 0 0 1-1.2-1.1L4.1 6.15Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path d="M3.4 5.15h13.2v2.1H3.4z" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M10 12.8V8.4m0 0L8.2 10.2M10 8.4l1.8 1.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.35"
      />
    </Icon>
  );
}

export function ChevronDownIcon() {
  return (
    <Icon>
      <path
        d="m5.7 8.1 4.3 4.1 4.3-4.1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </Icon>
  );
}

export function ChevronRightIcon() {
  return (
    <Icon>
      <path
        d="m8.1 5.7 4.1 4.3-4.1 4.3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </Icon>
  );
}

export function CheckIcon() {
  return (
    <Icon>
      <path
        d="m5.2 10.4 3.1 3.1 6.5-6.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </Icon>
  );
}

export function CustomizeSidebarIcon() {
  return (
    <Icon>
      <path
        d="M3.2 5.2h4.4M10.6 5.2h6.2M3.2 10h7.2M13.6 10h3.2M3.2 14.8h2.2M8.6 14.8h8.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
      <path
        d="M8.8 3.6v3.2M12.4 8.4v3.2M6.6 13.2v3.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </Icon>
  );
}

export function PencilIcon() {
  return (
    <Icon>
      <path
        d="M12.8 4.2a1.6 1.6 0 0 1 2.3 2.3L7.6 14l-3.1.8.8-3.1 7.5-7.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill="none"
      />
    </Icon>
  );
}

export function CopyIcon() {
  return (
    <Icon>
      <rect
        x="6.5"
        y="6.5"
        width="9"
        height="9"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
      <path
        d="M4.5 13.5V5a1.5 1.5 0 0 1 1.5-1.5h8.5"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinecap="round"
      />
    </Icon>
  );
}

export function SparkIcon() {
  return (
    <Icon>
      <path
        d="m10 3.1 1.55 3.66 3.66 1.55-3.66 1.55L10 13.5l-1.55-3.64L4.8 8.3l3.65-1.55L10 3.1Zm5 8.6.72 1.58 1.58.72-1.58.72L15 16.3l-.72-1.58-1.58-.72 1.58-.72.72-1.58Z"
        fill="currentColor"
      />
    </Icon>
  );
}

export function PiGlyphIcon() {
  return (
    <Icon>
      <path d="M5 5.25h10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
      <path d="M8 5.25v9.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
      <path
        d="M8 10.5c0-1.55 1.15-2.8 2.6-2.8 1.05 0 1.95.5 2.45 1.45"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </Icon>
  );
}
export function SettingsIcon() {
  return (
    <Icon>
      <path
        d="M8.8 3.6h2.4l.4 1.6 1.5.62 1.42-.85 1.7 1.7-.86 1.43.63 1.5 1.6.4v2.4l-1.6.4-.63 1.5.86 1.43-1.7 1.7-1.42-.85-1.5.62-.4 1.6H8.8l-.4-1.6-1.5-.62-1.42.85-1.7-1.7.86-1.43-.63-1.5-1.6-.4v-2.4l1.6-.4.63-1.5-.86-1.43 1.7-1.7 1.42.85 1.5-.62.4-1.6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
      <circle cx="10" cy="10" r="2.3" stroke="currentColor" strokeWidth="1.25" />
    </Icon>
  );
}

export function ModelIcon() {
  return (
    <Icon>
      <path
        d="M10 3.3 15.8 6.4v7.2L10 16.7 4.2 13.6V6.4L10 3.3Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
      <path d="M4.5 6.65 10 9.7l5.5-3.05M10 9.8v6.5" stroke="currentColor" strokeWidth="1.2" />
    </Icon>
  );
}

export function ReasoningIcon() {
  return (
    <Icon>
      <path
        d="M7.2 6.1a2.6 2.6 0 1 1 2.6 2.6v1.05M12.35 6.35a2.2 2.2 0 1 1-2.2-2.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path
        d="M7.2 13.6h5.6M8.2 16h3.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.35"
      />
    </Icon>
  );
}

export function StatusIcon() {
  return (
    <Icon>
      <path d="M4.3 10h11.4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <path d="M10 4.3v11.4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      <circle cx="10" cy="10" r="6.6" stroke="currentColor" strokeWidth="1.3" />
    </Icon>
  );
}

export function SkillIcon() {
  return (
    <Icon>
      <path
        d="M10 2.8 15.8 6v8L10 17.2 4.2 14V6L10 2.8Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path d="M10 2.8V17.2M4.2 6 10 9.2 15.8 6" stroke="currentColor" strokeWidth="1.2" />
    </Icon>
  );
}

export function ExtensionIcon() {
  return (
    <Icon>
      <path
        d="M8.2 3.5 6.7 5a2.3 2.3 0 1 0 1.8 1.8L10 5.3l1.5 1.5a2.3 2.3 0 1 0 1.8-1.8l-1.5-1.5H8.2Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.3"
      />
      <path d="M10 9.1v7.1" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
    </Icon>
  );
}

export function ClockIcon() {
  return (
    <Icon>
      <circle cx="10" cy="10" r="6.6" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M10 6.4V10l2.4 1.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
    </Icon>
  );
}

export function RefreshIcon() {
  return (
    <Icon>
      <path
        d="M15.1 8.2A5.6 5.6 0 1 0 15 12.8M15.2 4.9v3.7h-3.7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.45"
      />
    </Icon>
  );
}

export function PinIcon({ filled = false }: { readonly filled?: boolean }) {
  return (
    <Icon>
      <path
        d="M7.2 3.8h5.6l-.8 4 2.2 2.2v1.4H5.8V10l2.2-2.2-.8-4Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path d="M10 11.4v4.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.35" />
    </Icon>
  );
}

export function WorktreeIcon() {
  return (
    <Icon>
      <path
        d="M6 5.3h8.1v8.1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.45"
      />
      <path
        d="M13.9 5.45 5.9 13.45"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.45"
      />
      <path
        d="M5.85 9.75v3.95h3.95"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.45"
      />
    </Icon>
  );
}

export function ForkIcon() {
  return (
    <Icon>
      <circle cx="6" cy="5" r="1.85" stroke="currentColor" strokeWidth="1.45" />
      <circle cx="6" cy="15" r="1.85" stroke="currentColor" strokeWidth="1.45" />
      <circle cx="14" cy="5" r="1.85" stroke="currentColor" strokeWidth="1.45" />
      <path d="M6 6.85v6.3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.45" />
      <path
        d="M14 6.85v1.4c0 2.1-1.6 3.4-3.6 3.7L7.8 11.7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.45"
      />
    </Icon>
  );
}

export function GripIcon() {
  return (
    <Icon>
      <circle cx="8" cy="7" r="1.2" fill="currentColor" />
      <circle cx="12" cy="7" r="1.2" fill="currentColor" />
      <circle cx="8" cy="10" r="1.2" fill="currentColor" />
      <circle cx="12" cy="10" r="1.2" fill="currentColor" />
      <circle cx="8" cy="13" r="1.2" fill="currentColor" />
      <circle cx="12" cy="13" r="1.2" fill="currentColor" />
    </Icon>
  );
}

export function DiffIcon() {
  return (
    <Icon>
      <path
        d="M7 7h6M7 10h4M7 13h5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.3"
      />
      <rect
        x="4"
        y="4"
        width="12"
        height="12"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
      />
    </Icon>
  );
}

export function FileDiffIcon() {
  return (
    <Icon>
      <rect x="4" y="3.5" width="12" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M10 6.5v4M8 8.5h4M8 13.5h4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.3"
      />
    </Icon>
  );
}

export function ChatIcon() {
  return (
    <Icon>
      <path
        d="M4.2 5.6a1.9 1.9 0 0 1 1.9-1.9h7.8a1.9 1.9 0 0 1 1.9 1.9v5.2a1.9 1.9 0 0 1-1.9 1.9H9.1l-3.2 2.7v-2.7h.2a1.9 1.9 0 0 1-1.9-1.9V5.6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </Icon>
  );
}

export function SearchIcon() {
  return (
    <Icon>
      <circle cx="8.75" cy="8.75" r="4.9" stroke="currentColor" strokeWidth="1.6" />
      <path d="m12.4 12.4 3.6 3.6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
    </Icon>
  );
}

export function SunIcon() {
  return (
    <Icon>
      <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M10 3.2v1.4M10 15.4v1.4M3.2 10h1.4M15.4 10h1.4M5.2 5.2l1 1M13.8 13.8l1 1M5.2 14.8l1-1M13.8 6.2l1-1"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.35"
      />
    </Icon>
  );
}

export function PhoneIcon() {
  return (
    <Icon>
      <rect x="6" y="2.8" width="8" height="14.4" rx="2" stroke="currentColor" strokeWidth="1.35" />
      <path d="M9 14.6h2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.35" />
    </Icon>
  );
}

export function BellIcon() {
  return (
    <Icon>
      <path
        d="M5.6 13.6V9.2a4.4 4.4 0 0 1 8.8 0v4.4l1.1 1.4H4.5l1.1-1.4Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path
        d="M8.4 16.6a1.7 1.7 0 0 0 3.2 0"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.35"
      />
    </Icon>
  );
}

export function KeyboardIcon() {
  return (
    <Icon>
      <rect
        x="3.2"
        y="5.4"
        width="13.6"
        height="9.2"
        rx="1.8"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path
        d="M6.2 8.4h.1M8.7 8.4h.1M11.2 8.4h.1M13.7 8.4h.1M7.4 11.6h5.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </Icon>
  );
}

export function PlugIcon() {
  return (
    <Icon>
      <path
        d="M7.4 3.6v3M12.6 3.6v3M5.6 6.6h8.8v2.6a4.4 4.4 0 0 1-8.8 0V6.6ZM10 13.6v2.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
    </Icon>
  );
}

export function UsageIcon() {
  return (
    <Icon>
      <path
        d="M4.5 15.5v-4M8.5 15.5v-7.5M12.5 15.5v-5.5M16.5 15.5V5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
    </Icon>
  );
}

export function MoreIcon() {
  return (
    <Icon>
      <circle cx="5" cy="10" r="1.25" fill="currentColor" />
      <circle cx="10" cy="10" r="1.25" fill="currentColor" />
      <circle cx="15" cy="10" r="1.25" fill="currentColor" />
    </Icon>
  );
}

export function MinusIcon() {
  return (
    <Icon>
      <path d="M4.25 10h11.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </Icon>
  );
}
