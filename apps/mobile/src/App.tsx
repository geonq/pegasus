import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { ActivityIndicator, Pressable, Text, View, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
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
import { hitSize, type, usePalette } from "./theme";

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
      primary: palette.accent,
      background: palette.background,
      card: palette.surface,
      text: palette.text,
      border: palette.line,
    },
  };

  if (pairing === undefined) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: palette.background,
        }}
      >
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator>
        {pairing ? (
          <>
            <Stack.Screen
              name="Chats"
              component={ChatsScreen}
              options={({ navigation }) => ({
                title: pairing.hostName,
                headerLargeTitle: true,
                headerTransparent: false,
                headerStyle: { backgroundColor: palette.background },
                headerShadowVisible: false,
                headerRight: () => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Settings"
                    hitSlop={8}
                    onPress={() => navigation.navigate("Settings")}
                    style={{
                      minWidth: hitSize.min,
                      minHeight: hitSize.min,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: palette.accentText, fontSize: type.title }}>
                      Settings
                    </Text>
                  </Pressable>
                ),
              })}
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
              options={{ title: "Settings" }}
            />
            <Stack.Screen
              name="Usage"
              component={UsageScreen}
              options={{ title: "Usage", presentation: "modal" }}
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
        <PegasusProvider>
          <Root />
          <UpdatePrompt />
        </PegasusProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
