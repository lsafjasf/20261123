/** A single decoded frame, 8-bit RGBA, row-major. */
                        
                
                
                 
                          
 

                                                     

                      
                                                   
                                                                            
                                                                         
                      // frame repair switched off by the operator

                       
            
            
            
            
 

                            
             
                   
             
               
                             
                     
             
                                                                 
                                                             
                                                                        
    
                                                         
                                                                  
 

                              
                
                   
                    
                      
                     
 

                             
                                                     
                                                  
                 
 

                           
               
                    
           
                 
                  
                   
                
                       
    
            
                           
                              
                             
    
                        
                            
                         
            
                          
                        
                          
                           
                        
    
 

                                  
              
                                                                   
                                                                          
                              
                                                                 
                                                          
                                                                        
                                   
                                   
                                                                                  
 

export function defaultOptions()                  {
  return {
    fps: 24,
    repairStrength: 0.78,
    grainPreservation: 0.96,
    disabledFrames: new Set        (),
    windowRadius: 2,
    minDelta: 10,
    sigmaK: 3.0,
    scratchMinWidth: 1,
    scratchMaxWidth: 4,
    lockPersistence: 0.5,
  };
}
