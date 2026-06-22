import { useCallback, useEffect, useState } from "react";

type NativeAudioDevice = {
  id: string;
  name: string;
  kind: "audioinput" | "audiooutput";
  inputChannels?: number;
};

type UseAudioDevicesOptions = {
  setSelectedInputDeviceId: React.Dispatch<React.SetStateAction<string>>;
  setSelectedOutputDeviceId: React.Dispatch<React.SetStateAction<string>>;
  isNative?: boolean;
  listNativeAudioDevices?: () => Promise<NativeAudioDevice[]>;
};

export type UseAudioDevicesResult = {
  inputDevices: MediaDeviceInfo[];
  outputDevices: MediaDeviceInfo[];
  refreshAudioDevices: () => Promise<void>;
};

export function useAudioDevices({
  setSelectedInputDeviceId,
  setSelectedOutputDeviceId,
  isNative,
  listNativeAudioDevices,
}: UseAudioDevicesOptions): UseAudioDevicesResult {
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);

  const mapNativeDevice = (d: NativeAudioDevice): MediaDeviceInfo =>
    ({
      deviceId: d.id,
      groupId: "",
      kind: d.kind,
      label: d.name,
      inputChannels: d.inputChannels,
      toJSON: () => ({
        deviceId: d.id,
        groupId: "",
        kind: d.kind,
        label: d.name,
        inputChannels: d.inputChannels,
      }),
    }) as MediaDeviceInfo;

  const refreshAudioDevices = useCallback(async () => {
    let devices: MediaDeviceInfo[] = [];
    if (isNative && listNativeAudioDevices) {
      devices = (await listNativeAudioDevices()).map(mapNativeDevice);
    } else if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      devices = await navigator.mediaDevices.enumerateDevices();
    }
    const inputs = devices.filter((d) => d.kind === "audioinput");
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    setInputDevices(inputs);
    setOutputDevices(outputs);
    
    const params = new URLSearchParams(window.location.search);
    const audioInputMatch = params.get("audioInputMatch")?.toLowerCase();
    const audioOutputMatch = params.get("audioOutputMatch")?.toLowerCase();

    setSelectedInputDeviceId((prev) => {
      if (audioInputMatch) {
        const match = inputs.find((d) => d.label.toLowerCase().includes(audioInputMatch));
        if (match) return match.deviceId;
      }
      if (prev && inputs.some((d) => d.deviceId === prev)) return prev;
      return inputs[0]?.deviceId || "";
    });
    setSelectedOutputDeviceId((prev) => {
      if (audioOutputMatch) {
        const match = outputs.find((d) => d.label.toLowerCase().includes(audioOutputMatch));
        if (match) return match.deviceId;
      }
      if (prev && outputs.some((d) => d.deviceId === prev)) return prev;
      return "";
    });
  }, [
    isNative,
    listNativeAudioDevices,
    setSelectedInputDeviceId,
    setSelectedOutputDeviceId,
  ]);

  useEffect(() => {
    void refreshAudioDevices();
    if (isNative) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.addEventListener) return;
    navigator.mediaDevices.addEventListener("devicechange", refreshAudioDevices);
    return () =>
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        refreshAudioDevices,
      );
  }, [isNative, refreshAudioDevices]);

  return { inputDevices, outputDevices, refreshAudioDevices };
}
