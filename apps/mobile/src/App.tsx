import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { View, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DemoDirector } from "./demo/DemoDirector";
import NewChatScreen from "./features/home/NewChatScreen";
import ReviewScreen from "./features/review/ReviewScreen";
import SettingsScreen from "./features/settings/SettingsScreen";
import { UpdatePrompt } from "./features/updates/UpdatePrompt";
import type { RootStackParamList } from "./navigation";
import { ChatScreen } from "./screens/ChatScreen";
import { ChatsScreen } from "./screens/ChatsScreen";
import { PairScreen } from "./screens/PairScreen";
import { UsageScreen } from "./screens/UsageScreen";
import { PegasusProvider, usePegasus } from "./state/PegasusProvider";
import { usePalette } from "./theme";
import { OverlayProvider, Spinner } from "./ui";

const Stack = createNativeStackNavigator<RootStackParamList>();

function Root() {
  const palette = usePalette();
  const scheme = useColorScheme();
  const { pairing } = usePegasus();
  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.accentText,
      background: palette.background,
      card: palette.background,
      text: palette.textStrong,
      border: palette.line,
    },
  };

  if (pairing === undefined) {
    return (
      <View
        accessibilityLabel="Starting Pegasus"
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: palette.background,
        }}
      >
        <Spinner size={18} color={palette.textMuted} />
      </View>
    );
  }

  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator
        screenOptions={{
          // Every screen draws the Pegasus TopBar itself; the stack keeps the push and the edge
          // swipe back.
          headerShown: false,
          contentStyle: { backgroundColor: palette.background },
        }}
      >
        {pairing ? (
          <>
            <Stack.Screen name="Chats" component={ChatsScreen} />
            <Stack.Screen name="Chat" component={ChatScreen} />
            <Stack.Screen
              name="NewChat"
              component={NewChatScreen}
              options={{ presentation: "modal" }}
            />
            <Stack.Screen name="Review" component={ReviewScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen
              name="Usage"
              component={UsageScreen}
              options={{ presentation: "modal" }}
            />
          </>
        ) : (
          <Stack.Screen name="Pair" component={PairScreen} />
        )}
      </Stack.Navigator>
      <DemoDirector />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <PegasusProvider>
            <OverlayProvider>
              <Root />
              <UpdatePrompt />
            </OverlayProvider>
          </PegasusProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
