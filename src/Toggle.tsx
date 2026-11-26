// Gamepad-friendly on/off switch in the Core accent (crimson when on) -
// the Steam ToggleField look without its hardcoded blue accent.
import { Focusable } from "@decky/ui";
import { alpha, CRIMSON, WHITE } from "./palette";


export function AccentToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const flip = () => {
    if (!disabled) onChange(!checked);
  };
  return (
    <Focusable
      onActivate={flip}
      onClick={flip}
      style={{
        width: "42px",
        height: "24px",
        borderRadius: "12px",
        flexShrink: 0,
        background: checked ? CRIMSON : alpha(WHITE, 0.18),
        opacity: disabled ? 0.45 : 1,
        position: "relative",
        transition: "background 0.15s ease",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: "3px",
          left: checked ? "21px" : "3px",
          width: "18px",
          height: "18px",
          borderRadius: "50%",
          background: WHITE,
          transition: "left 0.15s ease",
        }}
      />
    </Focusable>
  );
}
