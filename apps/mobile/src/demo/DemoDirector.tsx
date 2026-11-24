import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import type { RootStackParamList } from "../navigation";
import { usePegasus } from "../state/PegasusProvider";
import { text } from "../theme";
import { useOverlay } from "../ui";
import { demoLaunch } from "./install";

/**
 * Demo mode only: opens the screen and floating layer the launch arguments name once the stand-in
 * PC is live, so each screenshot is one `simctl launch`. Renders nothing; does nothing in release.
 */
export function DemoDirector() {
  const [launch] = useState(demoLaunch);
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { status, pairing } = usePegasus();
  const overlay = useOverlay();
  const done = useRef(false);
  useEffect(() => {
    if (!launch || done.current || !pairing || status.state !== "live") return;
    done.current = true;
    const target = { workspaceId: "pegasus", sessionId: "phone-design" };
    const screen = launch.screen;
    if (screen === "Chat") navigation.navigate("Chat", { ...target, title: "" });
    if (screen === "ChatWaiting")
      navigation.navigate("Chat", { workspaceId: "seher", sessionId: "finance-sync", title: "" });
    if (screen === "Review") navigation.navigate("Review", target);
    if (screen === "Settings") navigation.navigate("Settings");
    if (screen === "NewChat") navigation.navigate("NewChat", { workspaceId: "pegasus" });
    if (screen === "Usage") navigation.navigate("Usage", target);
    // Not cleared on re-render: it runs once, after the screen has settled.
    setTimeout(
      () => {
        if (launch.overlay === "menu") {
          overlay.openMenu({ x: 334, y: 58, width: 44, height: 44 }, [
            {
              items: [
                {
                  id: "review",
                  label: "Review changes",
                  icon: "doc.text.magnifyingglass",
                  onPress: () => undefined,
                },
                {
                  id: "usage",
                  label: "Usage",
                  icon: "gauge.with.dots.needle.33percent",
                  onPress: () => undefined,
                },
                {
                  id: "new",
                  label: "New chat in this project",
                  icon: "square.and.pencil",
                  onPress: () => undefined,
                },
              ],
            },
            {
              items: [
                { id: "pin", label: "Pin", icon: "pin", onPress: () => undefined },
                {
                  id: "archive",
                  label: "Archive",
                  icon: "archivebox",
                  destructive: true,
                  onPress: () => undefined,
                },
              ],
            },
          ]);
        }
        if (launch.overlay === "confirm") {
          void overlay.confirm({
            title: "Archive this chat?",
            message: "It leaves the list. You can find it on the PC.",
            confirmLabel: "Archive",
            destructive: true,
          });
        }
        if (launch.overlay === "toast") {
          overlay.toast({
            message: "Chat archived",
            action: { label: "Undo", onPress: () => undefined },
          });
        }
        if (launch.overlay === "sheet") {
          overlay.openSheet(() => <Text style={text.body}>Sheet</Text>, "Sheet");
        }
      },
      launch.overlay === "toast" ? 5000 : 1400,
    );
  }, [launch, navigation, overlay, pairing, status.state]);
  return null;
}
