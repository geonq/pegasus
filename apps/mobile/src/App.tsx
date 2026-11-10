import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Pressable,
  Text,
  View,
  useColorScheme,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { RootStackParamList } from "./navigation";
import { ChatScreen } from "./screens/ChatScreen";
import { ChatsScreen } from "./screens/ChatsScreen";
import { PairScreen } from "./screens/PairScreen";
import { PegasusProvider, usePegasus } from "./state/PegasusProvider";
import { usePalette } from "./theme";

const Stack = createNativeStackNavigator<RootStackParamList>();

function Root() {
  const palette = usePalette();
  const scheme = useColorScheme();
  const { pairing, forget } = usePegasus();
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
              options={{
                title: pairing.hostName,
                headerLargeTitle: true,
                headerRight: () => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Connection"
                    hitSlop={12}
                    onPress={() =>
                      ActionSheetIOS.showActionSheetWithOptions(
                        {
                          options: ["Cancel", "Unpair this phone"],
                          destructiveButtonIndex: 1,
                          cancelButtonIndex: 0,
                          title: pairing.url,
                        },
                        (index) => {
                          if (index !== 1) return;
                          forget().catch((reason: unknown) =>
                            Alert.alert("Could not unpair", String(reason)),
                          );
                        },
                      )
                    }
                  >
                    <Text style={{ color: palette.accent, fontSize: 17 }}>•••</Text>
                  </Pressable>
                ),
              }}
            />
            <Stack.Screen name="Chat" component={ChatScreen} options={{ title: "" }} />
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
        </PegasusProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
