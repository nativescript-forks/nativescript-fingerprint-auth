import * as utils from "tns-core-modules/utils/utils";
import {
  FingerprintAuthApi,
  VerifyFingerprintOptions,
  VerifyFingerprintWithCustomFallbackOptions
} from "./fingerprint-auth.common";

const keychainItemIdentifier = "TouchIDKey";
let keychainItemServiceName = null;

export class FingerprintAuth implements FingerprintAuthApi {

  available(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        resolve(
            LAContext.new().canEvaluatePolicyError(
                LAPolicy.DeviceOwnerAuthenticationWithBiometrics));
      } catch (ex) {
        console.log(`fingerprint-auth.available: ${ex}`);
        resolve(false);
      }
    });
  }

  didFingerprintDatabaseChange(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        const laContext = LAContext.new();

        // we expect the dev to have checked 'isAvailable' already so this should not return an error,
        // we do however need to run canEvaluatePolicy here in order to get a non-nil evaluatedPolicyDomainState
        if (!laContext.canEvaluatePolicyError(LAPolicy.DeviceOwnerAuthenticationWithBiometrics)) {
          reject("Not available");
          return;
        }

        // only supported on iOS9+, so check this.. if not supported just report back as false
        if (utils.ios.MajorVersion < 9) {
          resolve(false);
          return;
        }

        const FingerprintDatabaseStateKey = "FingerprintDatabaseStateKey";
        const state = laContext.evaluatedPolicyDomainState;
        if (state !== null) {
          const stateStr = state.base64EncodedStringWithOptions(0);
          const standardUserDefaults = utils.ios.getter(NSUserDefaults, NSUserDefaults.standardUserDefaults);
          const storedState = standardUserDefaults.stringForKey(FingerprintDatabaseStateKey);

          // Store enrollment
          standardUserDefaults.setObjectForKey(stateStr, FingerprintDatabaseStateKey);
          standardUserDefaults.synchronize();

          // whenever a finger is added/changed/removed the value of the storedState changes,
          // so compare agains a value we previously stored in the context of this app
          const changed = storedState !== null && stateStr !== storedState;
          resolve(changed);
        }
      } catch (ex) {
        console.log(`Error in fingerprint-auth.didFingerprintDatabaseChange: ${ex}`);
        resolve(false);
      }
    });
  }

  /**
   * this 'default' method uses keychain instead of localauth so the passcode fallback can be used
   */
  verifyFingerprint(options: VerifyFingerprintOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        if (keychainItemServiceName === null) {
          const bundleID = utils.ios.getter(NSBundle, NSBundle.mainBundle).infoDictionary.objectForKey("CFBundleIdentifier");
          keychainItemServiceName = `${bundleID}.TouchID`;
        }

        if (!FingerprintAuth.createKeyChainEntry()) {
          this.verifyFingerprintWithCustomFallback(options).then(resolve, reject);
          return;
        }

        const query = NSMutableDictionary.alloc().init();
        query.setObjectForKey(kSecClassGenericPassword, kSecClass);
        query.setObjectForKey(keychainItemIdentifier, kSecAttrAccount);
        query.setObjectForKey(keychainItemServiceName, kSecAttrService);
        query.setObjectForKey(options !== null && options.message || "Scan your finger", kSecUseOperationPrompt);

        // Start the query and the fingerprint scan and/or device passcode validation
        const res = SecItemCopyMatching(query, null);
        if (res === 0) {
          resolve();
        } else {
          reject();
        }

      } catch (ex) {
        console.log(`Error in fingerprint-auth.verifyFingerprint: ${ex}`);
        reject(ex);
      }
    });
  }

  /**
   * This implementation uses LocalAuthentication and has no built-in passcode fallback
   */
  verifyFingerprintWithCustomFallback(options: VerifyFingerprintWithCustomFallbackOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const laContext = LAContext.new();
        if (!laContext.canEvaluatePolicyError(LAPolicy.DeviceOwnerAuthenticationWithBiometrics)) {
          reject("Not available");
          return;
        }

        const message = options !== null && options.message || "Scan your finger";
        if (options !== null && options.fallbackMessage) {
          laContext.localizedFallbackTitle = options.fallbackMessage;
        }
        laContext.evaluatePolicyLocalizedReasonReply(
            LAPolicy.DeviceOwnerAuthenticationWithBiometrics,
            message,
            (ok, error) => {
              if (ok) {
                resolve(ok);
              } else {
                reject({
                  code: error.code,
                  message: error.localizedDescription,
                });
              }
            }
        );
      } catch (ex) {
        console.log(`Error in fingerprint-auth.verifyFingerprint: ${ex}`);
        reject(ex);
      }
    });
  }

  private static createKeyChainEntry(): boolean {
    const attributes = NSMutableDictionary.new();
    attributes.setObjectForKey(kSecClassGenericPassword, kSecClass);
    attributes.setObjectForKey(keychainItemIdentifier, kSecAttrAccount);
    attributes.setObjectForKey(keychainItemServiceName, kSecAttrService);

    const accessControlRef = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        SecAccessControlCreateFlags.kSecAccessControlUserPresence,
        null
    );
    if (accessControlRef === null) {
      // console.log(`Can't store identifier '${keychainItemIdentifier}' in the KeyChain: ${accessControlError}.`);
      console.log(`Can't store identifier '${keychainItemIdentifier}' in the KeyChain.`);
      return false;
    } else {
      attributes.setObjectForKey(accessControlRef, kSecAttrAccessControl);
      // The content of the password is not important
      const content = NSString.stringWithString("dummy content");
      const nsData = content.dataUsingEncoding(NSUTF8StringEncoding);
      attributes.setObjectForKey(nsData, kSecValueData);

      SecItemAdd(attributes, null);
      return true;
    }
  }

}
