import "react-native-gesture-handler";
// Dev-only demo PC; a no-op unless the bundle was built with EXPO_PUBLIC_PEGASUS_DEMO=1.
import "./src/demo/install";
import { registerRootComponent } from "expo";
import App from "./src/App";

registerRootComponent(App);
