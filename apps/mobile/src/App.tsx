import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { ActivityIndicator, View, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
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
        <ActivityIndicator color={palette.textMuted} />
      </View>
    );
  }

  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator
        screenOptions={{
          // The system bar on the screen's background, no hairline, and a back chevron without the
          // previous screen's (often long) title.
          headerTransparent: false,
          headerShadowVisible: false,
          headerBackButtonDisplayMode: "minimal",
          headerStyle: { backgroundColor: palette.background },
          headerTintColor: palette.accentText,
          headerTitleStyle: { color: palette.textStrong },
          headerLargeTitleStyle: { color: palette.textStrong },
          contentStyle: { backgroundColor: palette.background },
        }}
      >
        {pairing ? (
          <>
            <Stack.Screen
              name="Chats"
              component={ChatsScreen}
              options={{
                title: pairing.hostName,
                headerLargeTitleEnabled: true,
                headerLargeTitleShadowVisible: false,
                headerLargeStyle: { backgroundColor: palette.background },
              }}
            />
            <Stack.Screen name="Chat" component={ChatScreen} options={{ title: "" }} />
            <Stack.Screen
              name="NewChat"
              component={NewChatScreen}
              options={{ title: "New chat", presentation: "modal" }}
            />
            <Stack.Screen name="Review" component={ReviewScreen} options={{ title: "Review" }} />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={{
                title: "Settings",
                headerLargeTitleEnabled: true,
                headerLargeTitleShadowVisible: false,
                headerLargeStyle: { backgroundColor: palette.background },
              }}
            />
            <Stack.Screen
              name="Usage"
              component={UsageScreen}
              options={{
                title: "Usage",
                presentation: "formSheet",
                sheetAllowedDetents: [0.6, 1],
                // The screen's SheetHeader draws the grabber with its title.
                sheetGrabberVisible: false,
                sheetCornerRadius: 18,
                headerShown: false,
              }}
            />
          </>
        ) : (
          <Stack.Screen name="Pair" component={PairScreen} options={{ headerShown: false }} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <PegasusProvider>
            <Root />
            <UpdatePrompt />
          </PegasusProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
