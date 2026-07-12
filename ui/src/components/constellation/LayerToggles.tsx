import type { DesignLayerKind, DesignLayers, LayerOption } from "../../designGraph";

type LayerTogglesProps = {
  options: LayerOption[];
  layers: DesignLayers;
  onToggle: (kind: DesignLayerKind) => void;
};

const isToggleable = (kind: LayerOption["kind"]): kind is DesignLayerKind =>
  kind === "execution" || kind === "data" || kind === "policy";

// Relationship-kind filter with honest availability: kinds without stored data render disabled
// with their reason instead of pretending to have edges.
export function LayerToggles({ options, layers, onToggle }: LayerTogglesProps) {
  return <fieldset className="design-layers">
    <legend>Relationship layers</legend>
    {options.map((option) => {
      const toggleable = isToggleable(option.kind) && option.available;
      return <label key={option.kind} className={`design-layer${option.available ? "" : " design-layer--unavailable"}`} title={option.note}>
        <input
          type="checkbox"
          checked={toggleable ? layers[option.kind as DesignLayerKind] : false}
          disabled={!toggleable}
          onChange={() => { if (toggleable) onToggle(option.kind as DesignLayerKind); }}
        />
        <span>{option.kind}{option.kind !== "execution" && option.available ? ` (${option.count})` : ""}</span>
        {option.note && <span className="muted design-layer-note">{option.note}</span>}
      </label>;
    })}
  </fieldset>;
}
