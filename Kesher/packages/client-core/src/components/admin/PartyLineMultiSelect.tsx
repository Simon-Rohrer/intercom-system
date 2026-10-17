import { type Dispatch, type SetStateAction } from "react";
import type { Room } from "../../types";
import { EntityMultiSelect } from "./EntityMultiSelect";

type PartyLineMultiSelectProps = {
  label: string;
  selectedPartyLineIds: string[];
  setState: Dispatch<SetStateAction<string[]>>;
  keyPrefix: string;
  partyLines: Room[]; // still using Room type for data
};

export function PartyLineMultiSelect({
  label,
  selectedPartyLineIds,
  setState,
  keyPrefix,
  partyLines,
}: PartyLineMultiSelectProps) {
  return (
    <EntityMultiSelect
      label={label}
      selectedIds={selectedPartyLineIds}
      setState={setState}
      keyPrefix={keyPrefix}
      options={partyLines.map((pl) => ({ id: pl.id, label: pl.name }))}
      noneSelectedLabel="Keine Party Line gewählt"
      clearLabel="Auswahl leeren"
    />
  );
}
